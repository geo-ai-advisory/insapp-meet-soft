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
/// верной разметки. Сравнение идёт с ЦЕНТРОМ голоса (среднее всех его реплик),
/// а не с первой репликой: центр устойчив, первая реплика - случайна.
const ASSIGN_THRESHOLD: f32 = 0.5;

/// Новый голос заводим только по достаточно длинной реплике (сек). Короткая
/// непохожая реплика - чаще всего тот же человек в плохих условиях (кашель,
/// шум, обрыв связи), а не новый участник. Её относим к ближайшему голосу.
const NEW_SPEAKER_MIN_SEC: f32 = 3.0;

/// Минимальная длительность куска речи для надёжного отпечатка (сек).
/// Короткие («ага», «да») не кластеризуем - приписываем последнему говорившему
/// собеседнику: это почти всегда продолжение его же реплики.
const MIN_SEGMENT_SEC: f32 = 1.2;

/// Сколько секунд после реплики собеседника короткие вставки считаем его
/// продолжением. Больше паузы - вставку никому не приписываем.
const STICKY_GUEST_SEC: f64 = 10.0;

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
struct VoiceModel {
    session: Session,
}

impl VoiceModel {
    fn load(path: &Path) -> Result<Self, String> {
        let session = Session::builder()
            .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Disable))
            .and_then(|b| b.with_intra_threads(2))
            .and_then(|b| b.commit_from_file(path))
            .map_err(|e| format!("Не загрузить модель распознавания говорящих: {}", e))?;
        Ok(Self { session })
    }

    /// Отпечаток голоса (единичной длины). `samples` - моно 16 кГц в диапазоне [-1, 1].
    fn embed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
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
}

static DIARIZER: Lazy<Mutex<Option<Diarizer>>> = Lazy::new(|| Mutex::new(None));

/// Путь к файлу модели в общей папке моделей приложения.
fn model_path() -> Option<PathBuf> {
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
            info!("[diarization] голоса прошлой встречи сброшены");
        }
    }
}

/// Освободить память модели (при остановке записи).
pub fn unload() {
    if let Ok(mut guard) = DIARIZER.lock() {
        if guard.is_some() {
            *guard = None;
            info!("[diarization] модель выгружена");
        }
    }
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

    // Короткая вставка («ага», «да») - отпечаток неустойчив. Приписываем
    // последнему говорившему собеседнику, если он был недавно.
    let duration = samples.len() as f32 / sample_rate.max(1) as f32;
    if duration < MIN_SEGMENT_SEC {
        if let Some((n, t)) = d.last_guest {
            if now - t <= STICKY_GUEST_SEC {
                d.last_guest = Some((n, now));
                return SpeakerRole::Guest(n);
            }
        }
        return SpeakerRole::Unknown;
    }

    let embedding = match d.model.embed(samples) {
        Some(e) => e,
        None => {
            warn!("[diarization] не посчитать отпечаток голоса");
            return SpeakerRole::Unknown;
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
    SpeakerRole::Guest(n)
}
