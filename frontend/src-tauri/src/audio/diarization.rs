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
use pyannote_rs::{EmbeddingExtractor, EmbeddingManager};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tracing::{info, warn};

/// Модель голосовых отпечатков (wespeaker CAM++, ~27 МБ, свободная загрузка).
const WESPEAKER_URL: &str =
    "https://github.com/thewh1teagle/pyannote-rs/releases/download/v0.1.0/wespeaker_en_voxceleb_CAM++.onnx";
const WESPEAKER_FILE: &str = "wespeaker_en_voxceleb_CAM++.onnx";

/// Максимум различаемых собеседников. Сверх лимита новый голос относим к
/// ближайшему известному - иначе на шуме плодятся «Собеседник 7, 8, 9...».
const MAX_SPEAKERS: usize = 6;

/// Порог схожести голосов (косинусная близость). Ниже порога - новый голос.
///
/// 0.15 подобран НА РЕАЛЬНЫХ ЗАПИСЯХ, а не взят из документации. Замеры:
///   - 48-мин встреча (3-4 участника, 363 реплики): 0.15 -> 4 голоса (верно),
///     0.35 -> 6, 0.50 -> 6 (переразмножение, упор в лимит)
///   - 3 телефонных звонка (по 2 участника): 0.15 -> 2 голоса в 2 из 3,
///     0.50 -> 4-5 голосов везде (сильное переразмножение)
/// Дефолт библиотеки (0.5) стабильно плодит несуществующих собеседников.
/// Смещаемся в сторону объединения: «двое слиты в одного» воспринимается
/// заметно лучше, чем пять фантомных собеседников в расшифровке.
const SIMILARITY_THRESHOLD: f32 = 0.15;

/// Минимальная длительность куска речи для надёжного отпечатка (сек).
/// На более коротких («ага», «да») отпечаток неустойчив - спикера не гадаем.
const MIN_SEGMENT_SEC: f32 = 0.8;

/// Различать собеседников между собой. Выключено - все чужие голоса идут одной
/// подписью «Собеседник» (поведение без диаризации). Переключается из UI.
static DIARIZE_GUESTS: AtomicBool = AtomicBool::new(true);

pub fn set_diarize_guests(enabled: bool) {
    DIARIZE_GUESTS.store(enabled, Ordering::Relaxed);
}

pub fn get_diarize_guests() -> bool {
    DIARIZE_GUESTS.load(Ordering::Relaxed)
}

struct Diarizer {
    extractor: EmbeddingExtractor,
    manager: EmbeddingManager,
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

    let extractor = EmbeddingExtractor::new(&path)
        .map_err(|e| format!("Не загрузить модель распознавания говорящих: {}", e))?;
    let manager = EmbeddingManager::new(MAX_SPEAKERS);

    let mut guard = DIARIZER.lock().map_err(|_| "diarizer lock".to_string())?;
    *guard = Some(Diarizer { extractor, manager });
    info!("[diarization] распознавание говорящих готово (до {} собеседников)", MAX_SPEAKERS);
    Ok(())
}

/// Сбросить накопленные голоса. Обязательно при старте НОВОЙ записи, иначе
/// «Собеседник 1» перетечёт из прошлой встречи в следующую.
pub fn reset() {
    if let Ok(mut guard) = DIARIZER.lock() {
        if let Some(d) = guard.as_mut() {
            d.manager = EmbeddingManager::new(MAX_SPEAKERS);
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

/// Определить номер говорящего для куска речи собеседников.
///
/// `samples` - моно 16 кГц (как отдаёт VAD). Возвращает 1-based номер
/// собеседника, либо None если определить не удалось (короткий кусок,
/// модель не готова, различение выключено) - тогда подпись будет общая.
pub fn identify_guest(samples: &[f32], sample_rate: u32) -> Option<usize> {
    if !get_diarize_guests() {
        return None;
    }
    // Слишком короткий кусок - отпечаток неустойчив, не гадаем.
    let duration = samples.len() as f32 / sample_rate.max(1) as f32;
    if duration < MIN_SEGMENT_SEC {
        return None;
    }

    // Модель ждёт 16-битный звук, у нас float - конвертируем с ограничением,
    // чтобы всплески не «заворачивались» в противоположный знак.
    let pcm: Vec<i16> = samples
        .iter()
        .map(|&x| (x.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect();

    let mut guard = DIARIZER.lock().ok()?;
    let d = guard.as_mut()?;

    let embedding: Vec<f32> = match d.extractor.compute(&pcm) {
        Ok(it) => it.collect(),
        Err(e) => {
            warn!("[diarization] не посчитать отпечаток голоса: {:?}", e);
            return None;
        }
    };
    if embedding.is_empty() {
        return None;
    }

    // Лимит исчерпан - относим к ближайшему известному голосу, новых не заводим.
    let id = if d.manager.get_all_speakers().len() >= MAX_SPEAKERS {
        d.manager.get_best_speaker_match(embedding).ok()?
    } else {
        d.manager.search_speaker(embedding, SIMILARITY_THRESHOLD)?
    };

    // Библиотека нумерует с нуля - людям показываем с единицы.
    Some(id + 1)
}
