//! Распознавание говорящих (диаризация) внутри канала собеседников.
//!
//! Зачем: канал микрофона - это всегда владелец записи («Вы»), а в системном
//! звуке (Zoom/Meet/звонок) могут говорить НЕСКОЛЬКО собеседников. Здесь мы
//! различаем их между собой по «голосовому отпечатку» и подписываем
//! «Собеседник 1», «Собеседник 2» и т.д.
//!
//! Как работает: для каждого куска речи (его уже нарезал VAD) считаем
//! embedding голоса моделью wespeaker и сравниваем с ранее услышанными
//! голосами по косинусной близости. Похож - тот же спикер, не похож - новый.
//!
//! Модель качается один раз (~27 МБ) и работает ЛОКАЛЬНО, как и распознавание
//! речи - запись никуда не уходит. Кроссплатформенно (ONNX Runtime), в отличие
//! от CoreML-решений, работающих только на Apple.

use once_cell::sync::Lazy;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tracing::{info, warn};

/// Модель голосовых отпечатков (wespeaker CAM++, ~27 МБ, свободная загрузка).
const WESPEAKER_URL: &str =
    "https://github.com/thewh1teagle/pyannote-rs/releases/download/v0.1.0/wespeaker_en_voxceleb_CAM++.onnx";
const WESPEAKER_FILE: &str = "wespeaker_en_voxceleb_CAM++.onnx";

/// Максимум различаемых собеседников. Сверх лимита новый голос относим к
/// ближайшему известному. 8 - на рабочих техничках бывает 7-9 человек (замер 23.09).
const MAX_SPEAKERS: usize = 8;

/// Порог схожести реплики с «центром голоса» собеседника (косинусная близость).
/// Выше порога - это тот же человек.
///
/// Подобран 23.09.2026 замером на 43 реальных встречах (журнал
/// Projects/insapp-meet/journals/2026-09-23-diarization-quality): на встречах один
/// на один даёт ровно одного собеседника, на смесях реплик разных людей - 93%
/// верной разметки. 29.09 проверен 0.55 (после слияния Климова и Листопада): на
/// настоящем коде стало хуже (87% против 93%) - оставлен 0.5. Слияния похожих голосов
/// исправляет пересмотр разметки (relabel_live / final_relabel), а не порог.
/// Сравнение идёт с ЦЕНТРОМ голоса (среднее всех его реплик), а не с первой репликой.
const ASSIGN_THRESHOLD: f32 = 0.5;

/// Разметка ПОСЛЕ встречи: все реплики собеседников раскладываются по голосам разом
/// (иерархическая кластеризация, средняя связь). Во время записи решение принимается
/// по одной реплике и не пересматривается - ранняя ошибка (слили двух людей) тянется
/// до конца встречи. После встречи видно всю картину: на встрече 29.09 - 95% верно
/// (онлайн 82%), на смесях реплик разных людей 100%, встречи один на один не дробятся.
/// Порог - косинусное расстояние между группами (0.5 = похожесть 0.5).
const FINAL_AHC_DISTANCE: f32 = 0.5;
/// Реплики не короче этого (сек) участвуют в кластеризации; короче - к ближайшему голосу.
const FINAL_LONG_SEC: f32 = 1.5;
/// Группа, набравшая меньше этого (сек речи), - осколок: сливаем с самым похожим голосом.
/// Не долей (было 4% в лаборатории): доля съедала тихих участников - человек с 30 с речи
/// на длинной встрече находился лишь в 27% случаев, с порогом 15 с - всегда.
const FINAL_SMALL_GROUP_SEC: f32 = 15.0;
/// Предел числа реплик для разметки после встречи (защита от долгой обработки).
const FINAL_MAX_SEGMENTS: usize = 4000;
/// Пересмотр разметки во время записи - не раньше, чем набралось столько длинных реплик.
const LIVE_MIN_LONG: usize = 6;
/// Во время записи не сливаем «маленькую» группу, если голос появился за последние
/// столько секунд: это может быть только что подключившийся человек, а не осколок.
const LIVE_PROTECT_RECENT_SEC: f64 = 120.0;

/// Новый голос заводим только по достаточно длинной реплике (сек). Короткая
/// непохожая реплика - чаще всего тот же человек в плохих условиях (кашель,
/// шум, обрыв связи), а не новый участник. Её относим к ближайшему голосу.
const NEW_SPEAKER_MIN_SEC: f32 = 3.0;

/// Минимальная длительность куска речи для надёжного отпечатка (сек).
/// Короткие («ага», «да») не кластеризуем - приписываем последнему говорившему
/// собеседнику: это почти всегда продолжение его же реплики.
const MIN_SEGMENT_SEC: f32 = 1.2;

/// Различать собеседников между собой. Выключено - все чужие голоса идут одной
/// подписью «Собеседник» (поведение без диаризации). Переключается из UI.
static DIARIZE_GUESTS: AtomicBool = AtomicBool::new(true);

pub fn set_diarize_guests(enabled: bool) {
    DIARIZE_GUESTS.store(enabled, Ordering::Relaxed);
}

pub fn get_diarize_guests() -> bool {
    DIARIZE_GUESTS.load(Ordering::Relaxed)
}

/// Кто произнёс реплику.
#[derive(Debug, Clone, PartialEq)]
pub enum SpeakerRole {
    /// Владелец записи - «Вы».
    Owner,
    /// Собеседник под номером (1-based) - «Собеседник N».
    Guest(usize),
    /// Не удалось определить (короткая реплика / модель не готова).
    Unknown,
}

/// Модель голосовых отпечатков, запущенная ПРАВИЛЬНО.
///
/// ВАЖНО: оптимизации графа ONNX Runtime ВЫКЛЮЧЕНЫ. На этой модели (CAM++) в нашей
/// версии ONNX Runtime любые оптимизации - даже базовые - молча портят результат:
/// из тех же признаков звука получается почти случайный отпечаток. Библиотека
/// pyannote-rs включает самый сильный уровень, и из-за этого до 23.09.2026
/// разделение собеседников не работало вовсе (то слипалось в «Вы», то дробилось
/// до потолка в 6 собеседников). Без оптимизаций результат совпадает с эталонным
/// onnxruntime до 7-го знака, скорость практически та же. НЕ ВКЛЮЧАТЬ обратно.
pub(crate) struct VoiceModel {
    session: Session,
}

impl VoiceModel {
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let session = Session::builder()
            .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Disable))
            .and_then(|b| b.with_intra_threads(2))
            .and_then(|b| b.commit_from_file(path))
            .map_err(|e| format!("Не загрузить модель распознавания говорящих: {}", e))?;
        Ok(Self { session })
    }

    /// Отпечаток голоса (единичной длины). `samples` - моно 16 кГц в диапазоне [-1, 1].
    pub(crate) fn embed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        let clean: Vec<f32> = samples.iter().map(|x| x.clamp(-1.0, 1.0)).collect();
        // Kaldi fbank 80 + вычитание среднего по времени - как при обучении модели.
        let feats = knf_rs::compute_fbank(&clean).ok()?;
        let (t, bins) = (feats.shape()[0], feats.shape()[1]);
        if t == 0 {
            return None;
        }
        let data: Vec<f32> = feats.iter().copied().collect();
        let tensor = Tensor::from_array(([1usize, t, bins], data)).ok()?;
        let out = self.session.run(ort::inputs!["feats" => tensor]).ok()?;
        let (_, d) = out.get("embs")?.try_extract_tensor::<f32>().ok()?;
        let mut e = d.to_vec();
        let n = e.iter().map(|x| x * x).sum::<f32>().sqrt();
        if !n.is_finite() || n == 0.0 {
            return None;
        }
        e.iter_mut().for_each(|x| *x /= n);
        Some(e)
    }
}

/// Голос собеседника: сумма отпечатков его реплик (с весом по длительности).
/// Направление суммы - «центр голоса»: уточняется с каждой репликой.
struct GuestVoice {
    sum: Vec<f32>,
}

impl GuestVoice {
    fn similarity(&self, e: &[f32]) -> f32 {
        let n = self.sum.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n == 0.0 {
            return -1.0;
        }
        self.sum.iter().zip(e).map(|(a, b)| a * b).sum::<f32>() / n
    }

    fn add(&mut self, e: &[f32], weight: f32) {
        self.sum.iter_mut().zip(e).for_each(|(s, x)| *s += x * weight);
    }
}

struct Diarizer {
    model: VoiceModel,
    /// Голоса собеседников в порядке появления: индекс + 1 = номер «Собеседник N».
    guests: Vec<GuestVoice>,
    /// Последний определённый собеседник и время его реплики (сек записи).
    /// Короткие вставки («ага», «да») приписываются ему - это почти всегда
    /// продолжение той же реплики, а отпечаток на них неустойчив.
    last_guest: Option<(usize, f64)>,
    /// Все реплики собеседников этой записи - для разметки после встречи.
    records: Vec<GuestRecord>,
}

/// Реплика собеседника так, как её разметили во время записи.
#[derive(Debug, Clone)]
pub struct GuestRecord {
    /// Начало реплики в записи (сек) - по нему реплика находится при сохранении.
    pub at: f64,
    /// Длительность (сек).
    pub dur: f32,
    /// Отпечаток голоса (нет у коротких вставок).
    pub emb: Option<Vec<f32>>,
    /// Номер собеседника во время записи (0 - не определён).
    pub live: usize,
}

static DIARIZER: Lazy<Mutex<Option<Diarizer>>> = Lazy::new(|| Mutex::new(None));

/// Итог разметки после встречи: начало реплики (мс) -> номер собеседника.
/// Считается при выгрузке модели (все реплики уже размечены), забирается при сохранении.
static FINAL_RELABEL: Lazy<Mutex<Option<std::collections::HashMap<i64, usize>>>> =
    Lazy::new(|| Mutex::new(None));

/// Голоса итоговых меток встречи: (номер собеседника, центр голоса, секунд речи).
/// Считаются вместе с FINAL_RELABEL, сохраняются при сохранении встречи (голоса коллег).
static FINAL_VOICES: Lazy<Mutex<Vec<(usize, Vec<f32>, f32)>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Голоса коллег (имя, центр голоса) - загружаются при старте записи для узнавания.
static PROFILES: Lazy<Mutex<Vec<(String, Vec<f32>)>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Задать голоса коллег для узнавания в этой записи.
pub fn set_profiles(profiles: Vec<(String, Vec<f32>)>) {
    if let Ok(mut p) = PROFILES.lock() {
        info!("[voices] голосов коллег для узнавания: {}", profiles.len());
        *p = profiles;
    }
}

/// Центр голоса и секунды речи каждой метки (метка 0 пропускается).
pub fn voices_of(records: &[GuestRecord], labels: &[usize]) -> Vec<(usize, Vec<f32>, f32)> {
    let mut by: std::collections::BTreeMap<usize, (Vec<f32>, f32)> = Default::default();
    for (r, &n) in records.iter().zip(labels) {
        if n == 0 {
            continue;
        }
        let e = by.entry(n).or_insert_with(|| (Vec::new(), 0.0));
        e.1 += r.dur;
        if let Some(emb) = r.emb.as_deref() {
            if e.0.is_empty() {
                e.0 = vec![0.0; emb.len()];
            }
            let w = r.dur.min(10.0);
            e.0.iter_mut().zip(emb).for_each(|(a, x)| *a += x * w);
        }
    }
    by.into_iter()
        .filter(|(_, (c, _))| !c.is_empty())
        .map(|(n, (mut c, sec))| {
            let norm = c.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                c.iter_mut().for_each(|x| *x /= norm);
            }
            (n, c, sec)
        })
        .collect()
}

/// Забрать голоса итоговых меток (один раз - для сохраняемой встречи).
pub fn take_final_voices() -> Vec<(usize, Vec<f32>, f32)> {
    FINAL_VOICES.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
}

/// Узнать собеседников этой записи по голосам коллег: (номер, имя, похожесть).
/// Только уверенные совпадения (см. voices::match_profiles); вызывается раз в ~30 с.
pub fn recognize_live() -> Vec<(usize, String, f32)> {
    let profiles = match PROFILES.lock() {
        Ok(p) if !p.is_empty() => p.clone(),
        _ => return Vec::new(),
    };
    let voices = match DIARIZER.lock() {
        Ok(g) => match g.as_ref() {
            Some(d) => {
                let labels: Vec<usize> = d.records.iter().map(|r| r.live).collect();
                voices_of(&d.records, &labels)
            }
            None => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    crate::audio::voices::match_profiles(&voices, &profiles)
}

/// Ключ реплики: начало в миллисекундах (одно и то же число приходит из записи и из
/// сохраняемой расшифровки).
pub fn segment_key(at_sec: f64) -> i64 {
    (at_sec * 1000.0).round() as i64
}

/// Путь к файлу модели в общей папке моделей приложения.
pub(crate) fn model_path() -> Option<PathBuf> {
    crate::parakeet_engine::commands::get_models_directory().map(|d| d.join(WESPEAKER_FILE))
}

/// Модель уже скачана?
pub fn is_model_downloaded() -> bool {
    model_path().map(|p| p.exists()).unwrap_or(false)
}

/// Скачать модель отпечатков, если её ещё нет. Идемпотентно.
pub async fn ensure_model() -> Result<PathBuf, String> {
    let path = model_path().ok_or_else(|| "Папка моделей не настроена".to_string())?;
    if path.exists() {
        return Ok(path);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Не создать папку моделей: {}", e))?;
    }

    info!("[diarization] качаю модель голосовых отпечатков (~27 МБ)...");
    let resp = reqwest::get(WESPEAKER_URL)
        .await
        .map_err(|e| format!("Не скачать модель распознавания говорящих: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Сервер моделей вернул {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Ошибка загрузки модели: {}", e))?;

    // Пишем во временный файл и переименовываем - чтобы прерванная загрузка
    // не оставила «обрезанную» модель, которая потом падает при инициализации.
    let tmp = path.with_extension("onnx.part");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Не сохранить модель: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Не переименовать модель: {}", e))?;

    info!("[diarization] модель скачана: {} ({} МБ)", path.display(), bytes.len() / 1024 / 1024);
    Ok(path)
}

/// Инициализировать распознавание говорящих (загрузить модель в память).
/// Вызывается при старте записи, если различение собеседников включено.
pub async fn init() -> Result<(), String> {
    if !get_diarize_guests() {
        return Ok(());
    }
    let path = ensure_model().await?;

    let model = VoiceModel::load(&path)?;

    let mut guard = DIARIZER.lock().map_err(|_| "diarizer lock".to_string())?;
    *guard = Some(Diarizer {
        model,
        guests: Vec::new(),
        last_guest: None,
        records: Vec::new(),
    });
    info!("[diarization] распознавание говорящих готово (до {} собеседников)", MAX_SPEAKERS);
    Ok(())
}

/// Сбросить накопленные голоса. Обязательно при старте НОВОЙ записи, иначе
/// «Собеседник 1» перетечёт из прошлой встречи в следующую.
pub fn reset() {
    if let Ok(mut guard) = DIARIZER.lock() {
        if let Some(d) = guard.as_mut() {
            d.guests.clear();
            d.last_guest = None;
            d.records.clear();
            info!("[diarization] голоса прошлой встречи сброшены");
        }
    }
    if let Ok(mut f) = FINAL_RELABEL.lock() {
        *f = None;
    }
    if let Ok(mut v) = FINAL_VOICES.lock() {
        v.clear();
    }
}

/// Освободить память модели (при остановке записи).
pub fn unload() {
    if let Ok(mut guard) = DIARIZER.lock() {
        if let Some(d) = guard.as_ref() {
            // Все реплики встречи уже размечены - пересматриваем разметку целиком.
            let started = std::time::Instant::now();
            let labels = final_relabel(&d.records);
            let mut map = std::collections::HashMap::new();
            let mut changed = 0usize;
            for (r, &n) in d.records.iter().zip(&labels) {
                if n > 0 {
                    if n != r.live {
                        changed += 1;
                    }
                    map.insert(segment_key(r.at), n);
                }
            }
            info!(
                "[diarization] разметка после встречи: реплик {}, изменено {}, за {} мс",
                d.records.len(),
                changed,
                started.elapsed().as_millis()
            );
            if let Ok(mut f) = FINAL_RELABEL.lock() {
                *f = if map.is_empty() { None } else { Some(map) };
            }
            if let Ok(mut v) = FINAL_VOICES.lock() {
                *v = voices_of(&d.records, &labels);
            }
        }
        if guard.is_some() {
            *guard = None;
            info!("[diarization] модель выгружена");
        }
    }
}

/// Забрать итог разметки после встречи (один раз - для сохраняемой встречи).
pub fn take_final_relabel() -> Option<std::collections::HashMap<i64, usize>> {
    FINAL_RELABEL.lock().ok().and_then(|mut f| f.take())
}

/// Определить, кто говорит.
///
/// ГЛАВНЫЙ принцип - канал решает сторону (подтверждено Geo 26.08):
/// - `from_mic = true` - микрофон пользователя. Это ВСЕГДА «Вы»: в наушниках
///   туда физически попадает только владелец. Никакой перекраски по голосу -
///   прежнее правило «узнаём владельца в любом канале» на реальной встрече
///   склеивало ВСЕХ собеседников в «Вы» и убило разметку целиком.
/// - `from_mic = false` - системный звук. Это ВСЕГДА собеседники, владельцем
///   не бывает. Голосовые отпечатки здесь только НУМЕРУЮТ собеседников
///   (Собеседник 1/2/3) - ошибка номера не путает стороны разговора.
///
/// `samples` - моно 16 кГц (как отдаёт VAD). Unknown = «Собеседник» без номера.
/// `at_sec` - время начала реплики в записи (сек): по нему короткие вставки
/// «липнут» к последнему говорившему.
pub fn identify_speaker(samples: &[f32], sample_rate: u32, from_mic: bool, at_sec: f64) -> SpeakerRole {
    // Микрофон - всегда владелец, без вариантов.
    if from_mic {
        return SpeakerRole::Owner;
    }

    // Различение собеседников выключено - общая подпись «Собеседник».
    if !get_diarize_guests() {
        return SpeakerRole::Unknown;
    }

    let now = at_sec;

    let mut guard = match DIARIZER.lock() {
        Ok(g) => g,
        Err(_) => return SpeakerRole::Unknown,
    };
    let d = match guard.as_mut() {
        Some(d) => d,
        // Модель ещё качается/не готова - не теряем реплику.
        None => return SpeakerRole::Unknown,
    };

    // Короткая вставка («ага», «да») - отпечаток неустойчив. Приписываем последнему
    // говорившему собеседнику, даже если он молчал давно: отдельный «Собеседник» без имени
    // из одной короткой реплики - мусор в списке участников (Geo 30.09: «это всё один человек»).
    let duration = samples.len() as f32 / sample_rate.max(1) as f32;
    if duration < MIN_SEGMENT_SEC {
        return stick_to_last(d, now, duration);
    }

    let embedding = match d.model.embed(samples) {
        Some(e) => e,
        None => {
            warn!("[diarization] не посчитать отпечаток голоса");
            return stick_to_last(d, now, duration);
        }
    };

    // Ближайший из уже известных голосов.
    let best = d
        .guests
        .iter()
        .enumerate()
        .map(|(i, g)| (i, g.similarity(&embedding)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let weight = duration.min(10.0);
    let idx = match best {
        // Тот же человек; либо реплика слишком короткая, чтобы заводить новый голос;
        // либо достигнут потолок числа собеседников.
        Some((i, sim))
            if sim > ASSIGN_THRESHOLD
                || duration < NEW_SPEAKER_MIN_SEC
                || d.guests.len() >= MAX_SPEAKERS =>
        {
            d.guests[i].add(&embedding, weight);
            i
        }
        // Новый голос.
        _ => {
            let mut g = GuestVoice { sum: vec![0.0; embedding.len()] };
            g.add(&embedding, weight);
            d.guests.push(g);
            d.guests.len() - 1
        }
    };

    let n = idx + 1;
    d.last_guest = Some((n, now));
    d.records.push(GuestRecord { at: now, dur: duration, emb: Some(embedding), live: n });
    SpeakerRole::Guest(n)
}

/// Реплика без надёжного отпечатка - последнему говорившему собеседнику; до первого собеседника - «Собеседник».
fn stick_to_last(d: &mut Diarizer, now: f64, duration: f32) -> SpeakerRole {
    if let Some((n, _)) = d.last_guest {
        d.last_guest = Some((n, now));
        d.records.push(GuestRecord { at: now, dur: duration, emb: None, live: n });
        return SpeakerRole::Guest(n);
    }
    d.records.push(GuestRecord { at: now, dur: duration, emb: None, live: 0 });
    SpeakerRole::Unknown
}

// ------------------------------------------------------------
// Разметка после встречи
// ------------------------------------------------------------

/// Пересмотреть разметку собеседников по всей встрече разом.
///
/// Возвращает новый номер собеседника для каждой реплики (0 - не определён, оставить
/// как было). Номера подбираются так, чтобы совпасть с номерами во время записи
/// (наибольшее совпадение по времени речи): имена, которые пользователь дал
/// собеседникам во время встречи, остаются у тех же людей. Если во время записи два
/// человека были слиты под одним номером, номер остаётся у того, кто говорил больше,
/// второй получает новый номер (или номер, под которым он уже мелькал).
pub fn final_relabel(records: &[GuestRecord]) -> Vec<usize> {
    relabel_impl(records, None)
}

/// Пересмотр разметки по ходу записи (раз в ~30 с): исправляет слияния похожих голосов
/// уже во время встречи. Возвращает изменившиеся реплики: (ключ начала, новый номер).
/// Центры голосов для дальнейших реплик пересчитываются по исправленной разметке.
/// Считается вне блокировки - распознавание реплик не ждёт.
pub fn relabel_live() -> Vec<(i64, usize)> {
    let snapshot: Vec<GuestRecord> = match DIARIZER.lock() {
        Ok(g) => match g.as_ref() {
            Some(d) => d.records.clone(),
            None => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    let long = snapshot.iter().filter(|r| r.emb.is_some() && r.dur >= FINAL_LONG_SEC).count();
    if long < LIVE_MIN_LONG {
        return Vec::new();
    }
    let now = snapshot.iter().map(|r| r.at).fold(0.0f64, f64::max);
    let labels = relabel_impl(&snapshot, Some(now - LIVE_PROTECT_RECENT_SEC));

    let mut guard = match DIARIZER.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let d = match guard.as_mut() {
        Some(d) => d,
        None => return Vec::new(),
    };
    let mut changes = Vec::new();
    for (i, &n) in labels.iter().enumerate() {
        if i >= d.records.len() || d.records[i].at != snapshot[i].at {
            break;
        }
        if n > 0 && d.records[i].live != n {
            d.records[i].live = n;
            changes.push((segment_key(d.records[i].at), n));
        }
    }
    if !changes.is_empty() {
        rebuild_guests(d);
        info!("[diarization] пересмотр разметки во время записи: переподписано реплик {}", changes.len());
    }
    changes
}

/// Центры голосов заново - по текущей разметке реплик.
fn rebuild_guests(d: &mut Diarizer) {
    let max_id = d.records.iter().map(|r| r.live).max().unwrap_or(0);
    let dim = d.records.iter().find_map(|r| r.emb.as_ref().map(|e| e.len())).unwrap_or(0);
    let mut guests: Vec<GuestVoice> = (0..max_id).map(|_| GuestVoice { sum: vec![0.0; dim] }).collect();
    let mut last: Option<(usize, f64)> = None;
    for r in &d.records {
        if r.live == 0 {
            continue;
        }
        if let Some(e) = r.emb.as_deref() {
            guests[r.live - 1].add(e, r.dur.min(10.0));
        }
        if last.map(|(_, t)| r.at >= t).unwrap_or(true) {
            last = Some((r.live, r.at));
        }
    }
    d.guests = guests;
    if let Some((n, t)) = last {
        d.last_guest = Some((n, t));
    }
}

pub(crate) fn relabel_impl(records: &[GuestRecord], protect_since: Option<f64>) -> Vec<usize> {
    let keep: Vec<usize> = records.iter().map(|r| r.live).collect();
    let long: Vec<usize> = (0..records.len())
        .filter(|&i| records[i].emb.is_some() && records[i].dur >= FINAL_LONG_SEC)
        .collect();
    if long.len() < 2 || long.len() > FINAL_MAX_SEGMENTS {
        return keep;
    }

    // 1. Группы голосов по длинным репликам.
    let embs: Vec<&[f32]> = long.iter().map(|&i| records[i].emb.as_deref().unwrap()).collect();
    let groups = ahc_average(&embs, FINAL_AHC_DISTANCE);
    let k = groups.iter().copied().max().map(|m| m + 1).unwrap_or(0);
    let mut label = vec![0usize; records.len()]; // группа + 1, 0 - нет
    for (&i, &g) in long.iter().zip(&groups) {
        label[i] = g + 1;
    }

    // Центры групп (с весом по длительности, как во время записи).
    let dim = embs[0].len();
    let mut cent = vec![vec![0f32; dim]; k];
    for &i in &long {
        let w = records[i].dur.min(10.0);
        let c = &mut cent[label[i] - 1];
        for (a, x) in c.iter_mut().zip(records[i].emb.as_deref().unwrap()) {
            *a += x * w;
        }
    }
    for c in cent.iter_mut() {
        let n = c.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > 0.0 {
            c.iter_mut().for_each(|x| *x /= n);
        }
    }
    let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
    let nearest = |e: &[f32], cent: &[Vec<f32>], allowed: &dyn Fn(usize) -> bool| -> Option<usize> {
        (0..cent.len())
            .filter(|&g| allowed(g))
            .max_by(|&a, &b| dot(e, &cent[a]).partial_cmp(&dot(e, &cent[b])).unwrap_or(std::cmp::Ordering::Equal))
    };

    // 2. Короткие реплики с отпечатком - к ближайшему голосу; без отпечатка - к тому,
    //    кто говорил перед ними (не дальше 10 с), по порядку времени.
    for i in 0..records.len() {
        if label[i] == 0 {
            if let Some(e) = records[i].emb.as_deref() {
                if let Some(g) = nearest(e, &cent, &|_| true) {
                    label[i] = g + 1;
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..records.len()).collect();
    order.sort_by(|&a, &b| records[a].at.partial_cmp(&records[b].at).unwrap_or(std::cmp::Ordering::Equal));
    // Реплики без отпечатка - к предыдущему собеседнику (без окна по времени: отдельный безымянный
    // «Собеседник» из коротких реплик - мусор), а те, что были до первого собеседника, - к первому.
    let mut last: Option<usize> = None;
    for &i in &order {
        if label[i] > 0 {
            last = Some(label[i]);
        } else if let Some(l) = last {
            label[i] = l;
        }
    }
    if let Some(&first) = order.iter().find(|&&i| label[i] > 0) {
        let l = label[first];
        for &i in &order {
            if label[i] > 0 {
                break;
            }
            label[i] = l;
        }
    }

    // 3. Осколки (< 15 с речи) - к самому похожему крупному голосу.
    let mut total = vec![0f32; k];
    for (i, r) in records.iter().enumerate() {
        if label[i] > 0 {
            total[label[i] - 1] += r.dur;
        }
    }
    // Во время записи свежий голос (появился недавно) не сливаем, даже если он пока
    // маленький: иначе только что подключившегося человека приклеили бы к похожему.
    let mut first_at = vec![f64::INFINITY; k];
    for (i, r) in records.iter().enumerate() {
        if label[i] > 0 {
            first_at[label[i] - 1] = first_at[label[i] - 1].min(r.at);
        }
    }
    let big: Vec<bool> = (0..k)
        .map(|g| total[g] >= FINAL_SMALL_GROUP_SEC || protect_since.map(|t0| first_at[g] >= t0).unwrap_or(false))
        .collect();
    if big.iter().any(|&b| b) {
        let remap: Vec<usize> = (0..k)
            .map(|g| if big[g] { g } else { nearest(&cent[g], &cent, &|h| big[h]).unwrap_or(g) })
            .collect();
        for l in label.iter_mut() {
            if *l > 0 {
                *l = remap[*l - 1] + 1;
            }
        }
    }

    // 4. Номера групп - как во время записи (наибольшее совпадение по времени речи).
    let live_max = records.iter().map(|r| r.live).max().unwrap_or(0);
    let mut groups_used: Vec<usize> = label.iter().filter(|&&l| l > 0).map(|&l| l - 1).collect();
    groups_used.sort_unstable();
    groups_used.dedup();
    let mut overlap = vec![vec![0f64; groups_used.len()]; live_max];
    for (i, r) in records.iter().enumerate() {
        if r.live > 0 && label[i] > 0 {
            let gi = groups_used.binary_search(&(label[i] - 1)).unwrap();
            overlap[r.live - 1][gi] += r.dur as f64;
        }
    }
    let assign = hungarian_max(&overlap); // для каждого номера записи - группа
    let mut number = vec![0usize; groups_used.len()];
    for (live, g) in assign.iter().enumerate() {
        if let Some(g) = g {
            number[*g] = live + 1;
        }
    }
    // Группы без пары - новые номера, по порядку первого появления.
    let mut next = live_max + 1;
    for &i in &order {
        if label[i] > 0 {
            let gi = groups_used.binary_search(&(label[i] - 1)).unwrap();
            if number[gi] == 0 {
                number[gi] = next;
                next += 1;
            }
        }
    }
    (0..records.len())
        .map(|i| if label[i] > 0 { number[groups_used.binary_search(&(label[i] - 1)).unwrap()] } else { 0 })
        .collect()
}

/// Иерархическая кластеризация со средней связью (как scipy linkage «average» +
/// fcluster по расстоянию): сливаем ближайшие группы, пока расстояние между ними
/// (1 - косинусная близость) не больше `max_dist`. Отпечатки - единичной длины.
fn ahc_average(embs: &[&[f32]], max_dist: f32) -> Vec<usize> {
    let n = embs.len();
    if n <= 1 {
        return vec![0; n];
    }
    let mut d = vec![0f32; n * n];
    for i in 0..n {
        for j in (i + 1)..n {
            let v = 1.0 - embs[i].iter().zip(embs[j]).map(|(a, b)| a * b).sum::<f32>();
            d[i * n + j] = v;
            d[j * n + i] = v;
        }
    }
    let mut size = vec![1f32; n];
    let mut active = vec![true; n];
    let mut parent: Vec<usize> = (0..n).collect();
    let nearest_of = |d: &[f32], active: &[bool], i: usize| -> (f32, usize) {
        let mut best = (f32::INFINITY, usize::MAX);
        for j in 0..n {
            if j != i && active[j] && d[i * n + j] < best.0 {
                best = (d[i * n + j], j);
            }
        }
        best
    };
    // Ближайший сосед каждой группы - чтобы не искать минимум по всей матрице каждый раз.
    let mut nn: Vec<(f32, usize)> = (0..n).map(|i| nearest_of(&d, &active, i)).collect();
    loop {
        let mut best = (f32::INFINITY, usize::MAX, usize::MAX);
        for i in 0..n {
            if active[i] && nn[i].0 < best.0 {
                best = (nn[i].0, i, nn[i].1);
            }
        }
        if best.1 == usize::MAX || best.0 > max_dist {
            break;
        }
        let (_, i, j) = best;
        // Слияние j в i: расстояние новой группы - среднее с весом по размерам
        // (формула Ланса-Уильямса для средней связи).
        let (si, sj) = (size[i], size[j]);
        for k in 0..n {
            if active[k] && k != i && k != j {
                let v = (si * d[i * n + k] + sj * d[j * n + k]) / (si + sj);
                d[i * n + k] = v;
                d[k * n + i] = v;
            }
        }
        size[i] += sj;
        active[j] = false;
        parent[j] = i;
        nn[i] = nearest_of(&d, &active, i);
        // Новое расстояние до слитой группы не меньше прежних двух - пересчитывать
        // нужно только тех, чьим ближайшим соседом была одна из слитых групп.
        for k in 0..n {
            if active[k] && k != i && (nn[k].1 == i || nn[k].1 == j) {
                nn[k] = nearest_of(&d, &active, k);
            }
        }
    }
    let root = |mut x: usize| {
        while parent[x] != x {
            x = parent[x];
        }
        x
    };
    let mut ids: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    (0..n)
        .map(|x| {
            let r = root(x);
            let next = ids.len();
            *ids.entry(r).or_insert(next)
        })
        .collect()
}

/// Назначение с наибольшим суммарным весом (венгерский алгоритм): строке - не больше
/// одного столбца и наоборот. Пары с нулевым весом не назначаются.
fn hungarian_max(w: &[Vec<f64>]) -> Vec<Option<usize>> {
    let n = w.len();
    let m = w.first().map(|r| r.len()).unwrap_or(0);
    let s = n.max(m);
    if s == 0 {
        return vec![None; n];
    }
    let maxw = w.iter().flatten().cloned().fold(0.0f64, f64::max);
    let cost = |i: usize, j: usize| if i < n && j < m { maxw - w[i][j] } else { maxw };
    let inf = f64::INFINITY;
    let (mut u, mut v) = (vec![0.0f64; s + 1], vec![0.0f64; s + 1]);
    let (mut p, mut way) = (vec![0usize; s + 1], vec![0usize; s + 1]);
    for i in 1..=s {
        p[0] = i;
        let mut j0 = 0usize;
        let mut minv = vec![inf; s + 1];
        let mut used = vec![false; s + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let (mut delta, mut j1) = (inf, 0usize);
            for j in 1..=s {
                if !used[j] {
                    let cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=s {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut res = vec![None; n];
    for j in 1..=s {
        let i = p[j];
        if i >= 1 && i <= n && j <= m && w[i - 1][j - 1] > 0.0 {
            res[i - 1] = Some(j - 1);
        }
    }
    res
}

#[cfg(test)]
mod relabel_tests {
    use super::*;

    /// Единичный вектор «голоса» с небольшим шумом вокруг направления `base`.
    fn voice(base: usize, noise: f32, seed: u32) -> Vec<f32> {
        let mut v = vec![0f32; 16];
        v[base] = 1.0;
        let mut x = seed.wrapping_mul(2654435761);
        for e in v.iter_mut() {
            x ^= x << 13; x ^= x >> 17; x ^= x << 5;
            *e += noise * ((x % 1000) as f32 / 1000.0 - 0.5);
        }
        let n = v.iter().map(|a| a * a).sum::<f32>().sqrt();
        v.iter().map(|a| a / n).collect()
    }

    #[test]
    fn hungarian_picks_max_total_overlap() {
        // Номер 1 (слитый) пересекается с группами A=2.6 и B=2.4, номер 2 - только с B.
        let w = vec![vec![2.6, 2.4], vec![0.0, 0.02]];
        assert_eq!(hungarian_max(&w), vec![Some(0), Some(1)]);
        // Нулевой вес не назначается.
        assert_eq!(hungarian_max(&vec![vec![0.0, 1.0], vec![0.0, 0.0]]), vec![Some(1), None]);
    }

    #[test]
    fn ahc_separates_voices_and_keeps_one_person_together() {
        let embs: Vec<Vec<f32>> = (0..30).map(|i| voice(i % 3, 0.3, i as u32 + 1)).collect();
        let refs: Vec<&[f32]> = embs.iter().map(|e| e.as_slice()).collect();
        let g = ahc_average(&refs, 0.5);
        for i in 0..30 {
            for j in 0..30 {
                assert_eq!(g[i] == g[j], i % 3 == j % 3, "реплики {} и {}", i, j);
            }
        }
    }

    #[test]
    fn merged_people_are_split_and_names_stay() {
        // Во время записи двух людей (голоса 0 и 1) слили под номер 1; номер 2 - третий человек.
        let mut recs = Vec::new();
        let mut t = 0.0;
        for i in 0..40u32 {
            let (v, live) = match i % 4 { 0 | 1 => (0, 1), 2 => (1, 1), _ => (2, 2) };
            recs.push(GuestRecord { at: t, dur: 4.0, emb: Some(voice(v, 0.3, i + 7)), live });
            t += 5.0;
        }
        let out = final_relabel(&recs);
        // Голос 0 (больше речи под номером 1) остаётся номером 1, третий - номером 2,
        // голос 1 получает новый номер 3.
        for (r, &n) in recs.iter().zip(&out) {
            let v = if r.live == 2 { 2 } else if n == 1 { 0 } else { 1 };
            let want = match v { 0 => 1, 1 => 3, _ => 2 };
            assert_eq!(n, want, "реплика в {} c", r.at);
        }
    }

    #[test]
    fn short_quiet_new_voice_is_protected_only_while_recent() {
        // Человек А говорит 3 минуты, в конце вступает Б на 8 с - меньше порога осколка.
        let mut recs = Vec::new();
        for i in 0..40u32 {
            recs.push(GuestRecord { at: i as f64 * 5.0, dur: 4.0, emb: Some(voice(0, 0.3, i + 1)), live: 1 });
        }
        for i in 0..2u32 {
            recs.push(GuestRecord { at: 200.0 + i as f64 * 5.0, dur: 4.0, emb: Some(voice(5, 0.3, i + 100)), live: 1 });
        }
        // Во время записи (голос свежий) - Б отдельно.
        let live = relabel_impl(&recs, Some(205.0 - LIVE_PROTECT_RECENT_SEC));
        assert_ne!(live[40], live[0]);
        // После встречи 8 с речи - осколок, сливается (порог 15 с).
        let fin = final_relabel(&recs);
        assert_eq!(fin[40], fin[0]);
    }
}
