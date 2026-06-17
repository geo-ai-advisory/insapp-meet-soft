// Insapp Server Integration
// Отправляет транскрипты встреч на наш корпоративный сервер с поддержкой очереди и retry.
//
// Логика:
//   1. После save_transcript собираем markdown + meta
//   2. Шлём POST на http://<server>/api/v1/transcripts с X-Insapp-Api-Key
//   3. Если сервер недоступен - кладём в локальную очередь в SQLite (sync_queue)
//   4. При следующем save_transcript или при ручной "Sync now" - пробуем отправить накопившееся
//
// API key хранится в macOS Keychain (через crate keyring).
// Адрес сервера и настройки хранятся в общей таблице settings (через SettingsRepository).

use chrono::Utc;
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::api::TranscriptSegment;

const CREDENTIALS_FILENAME: &str = "insapp-credentials.json";
const DEFAULT_SERVER: &str = "https://test-meet-dashboard.insapp.pro";

// Общий ключ убран намеренно. Теперь каждый сотрудник регистрируется при первом
// запуске (вводит ФИО), сервер выдаёт ему персональный ключ. Это позволяет видеть
// в админке кто именно загрузил конкретную встречу. До регистрации ключа нет -
// get_api_key() возвращает пустую строку, отправка идёт в Disabled статус.

/// Настройки интеграции с сервером Insapp - хранится в таблице settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsappServerSettings {
    /// Адрес сервера (по умолчанию https://test-meet-dashboard.insapp.pro)
    pub server_url: String,
    /// Автоматически отправлять транскрипты после сохранения встречи
    pub auto_upload: bool,
}

impl Default for InsappServerSettings {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_SERVER.to_string(),
            auto_upload: true,
        }
    }
}

/// Статус отправки транскрипта.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SyncStatus {
    /// Успешно отправлено
    Sent,
    /// Ждёт в очереди (сервер недоступен)
    Pending,
    /// Ошибка отправки (неправильный ключ или невалидный payload)
    Failed,
    /// Отключено в настройках
    Disabled,
}

/// Метаданные для отправки на сервер вместе с markdown.
///
/// ВАЖНО про duration_sec: тип должен быть `i64`, не `f64` — сервер (.NET)
/// объявил `int? DurationSec` в TranscriptInput. Если слать дробное число —
/// сервер падает с 400 "invalid meta JSON: ... Path: $.duration_sec".
/// На стороне Rust считаем длительность как float (например 15.5 сек) и
/// округляем до целого в `for_transcript` перед сериализацией.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptMeta {
    pub meeting_id: String,
    pub title: String,
    pub created_at: String,
    pub duration_sec: Option<i64>,
    pub language: Option<String>,
    pub source: String,
    pub kind: String,
    /// Тип встречи: 'internal' | 'external'. Дашборд читает это поле из meta.
    pub meeting_type: String,
}

impl TranscriptMeta {
    pub fn for_transcript(meeting_id: &str, title: &str, duration_sec: Option<f64>) -> Self {
        Self {
            meeting_id: meeting_id.to_string(),
            title: title.to_string(),
            created_at: Utc::now().to_rfc3339(),
            // f64 → i64 округлением. Сервер ждёт целое число (.NET int?).
            duration_sec: duration_sec.map(|d| d.round() as i64),
            language: None,
            source: "insapp-meet".to_string(),
            kind: "transcript".to_string(),
            // По умолчанию внутренняя; реальный тип проставляется на сайте загрузки из встречи.
            meeting_type: "internal".to_string(),
        }
    }
}

/// Конвертирует список сегментов транскрипта в один markdown-файл.
pub fn segments_to_markdown(meeting_title: &str, segments: &[TranscriptSegment]) -> String {
    let mut buf = String::new();
    buf.push_str(&format!("# {}\n\n", meeting_title));
    buf.push_str(&format!("_Источник: Insapp-meet_\n\n"));

    for seg in segments {
        let timestamp = seg
            .audio_start_time
            .map(format_timestamp)
            .unwrap_or_else(|| seg.timestamp.clone());
        buf.push_str(&format!("**[{}]** {}\n\n", timestamp, seg.text.trim()));
    }

    buf
}

fn format_timestamp(seconds: f64) -> String {
    let total = seconds as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

/// Файл с API-ключом.
///
/// Лежит в `<app_data_dir>/insapp-credentials.json`. Это обычный JSON-файл,
/// права 0600 (читает только владелец). НЕ используем Keychain - он вызывает
/// macOS-промпт «введите пароль связки ключей» при разной подписи приложения,
/// что ломает UX. Файл в app_data_dir безопаснее для single-user сценария
/// и не требует никаких prompts.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredCredentials {
    api_key: String,
    /// ФИО пользователя, под которым выпущен ключ (для UI индикации "ты вошёл как ...").
    #[serde(default)]
    full_name: String,
}

fn credentials_path() -> Option<std::path::PathBuf> {
    // Используем dirs::data_local_dir() - кроссплатформенно
    dirs::data_dir().map(|d| d.join("tech.insap.meet").join(CREDENTIALS_FILENAME))
}

fn read_credentials() -> StoredCredentials {
    let path = match credentials_path() {
        Some(p) => p,
        None => return StoredCredentials::default(),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return StoredCredentials::default(),
    };
    serde_json::from_str::<StoredCredentials>(&content).unwrap_or_default()
}

/// Получить API-ключ. Возвращает персональный ключ пользователя или пустую
/// строку если он ещё не зарегистрировался (тогда отправка идёт в Disabled).
pub fn get_api_key() -> String {
    read_credentials().api_key.trim().to_string()
}

/// ФИО зарегистрированного пользователя (или пусто).
pub fn get_full_name() -> String {
    read_credentials().full_name.trim().to_string()
}

/// Зарегистрирован ли пользователь (есть ли валидный ключ).
pub fn is_registered() -> bool {
    !get_api_key().is_empty()
}

/// Какой именно ключ сейчас активен - для UI индикации.
pub fn key_source() -> &'static str {
    if get_api_key().is_empty() {
        "none"
    } else {
        "user"
    }
}

/// Алиас для обратной совместимости.
pub fn get_or_create_api_key() -> Result<String, String> {
    Ok(get_api_key())
}

/// Сохранить API-ключ (без изменения ФИО - для ручного ввода в Настройках).
pub fn set_api_key(key: &str) -> Result<(), String> {
    let existing = read_credentials();
    save_credentials(key, &existing.full_name)
}

/// Сохранить ключ + ФИО (используется при self-register).
pub fn set_credentials(key: &str, full_name: &str) -> Result<(), String> {
    save_credentials(key, full_name)
}

fn save_credentials(key: &str, full_name: &str) -> Result<(), String> {
    let path = credentials_path().ok_or_else(|| "Не удалось получить app_data_dir".to_string())?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Не удалось создать папку: {}", e))?;
    }

    let creds = StoredCredentials {
        api_key: key.to_string(),
        full_name: full_name.to_string(),
    };
    let json = serde_json::to_string_pretty(&creds)
        .map_err(|e| format!("JSON serialize: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Не удалось записать файл: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&path) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }

    info!("Credentials Insapp сервера сохранены в {}", path.display());
    Ok(())
}

/// Удалить API-ключ.
pub fn delete_api_key() -> Result<(), String> {
    if let Some(path) = credentials_path() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Отправить markdown транскрипт на сервер Insapp.
///
/// Возвращает `Ok(SyncStatus::Sent)` при успехе.
/// При сетевой ошибке возвращает `Ok(SyncStatus::Pending)` - значит надо положить в очередь.
/// При 4xx возвращает `Ok(SyncStatus::Failed)` - ключ неверный или payload не годится.
pub async fn upload_transcript(
    server_url: &str,
    api_key: &str,
    markdown: &str,
    meta: &TranscriptMeta,
) -> Result<SyncStatus, String> {
    let url = format!("{}/api/v1/transcripts", server_url.trim_end_matches('/'));

    let meta_json = serde_json::to_string(meta).map_err(|e| format!("meta serialize: {}", e))?;

    let form = multipart::Form::new()
        .text("meta", meta_json)
        .part(
            "markdown",
            multipart::Part::text(markdown.to_string())
                .file_name(format!("{}.md", meta.meeting_id))
                .mime_str("text/markdown")
                .map_err(|e| format!("mime: {}", e))?,
        );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("client build: {}", e))?;

    let resp = match client
        .post(&url)
        .header("X-Insapp-Api-Key", api_key)
        .multipart(form)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            warn!("Insapp server недоступен ({}), отложу в очередь: {}", url, e);
            return Ok(SyncStatus::Pending);
        }
    };

    let status = resp.status();
    if status.is_success() {
        info!("Транскрипт {} отправлен на {}", meta.meeting_id, url);
        return Ok(SyncStatus::Sent);
    }

    if status.is_client_error() {
        let body = resp.text().await.unwrap_or_default();
        error!(
            "Сервер Insapp вернул {} для встречи {}: {}",
            status, meta.meeting_id, body
        );
        return Ok(SyncStatus::Failed);
    }

    // 5xx - сервер живой но падает, кладём в очередь чтобы попробовать позже
    warn!(
        "Insapp server вернул {} для {}, отложу в очередь",
        status, meta.meeting_id
    );
    Ok(SyncStatus::Pending)
}

/// Запись в очереди sync_queue (отложенные отправки).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct QueuedUpload {
    pub id: String,
    pub meeting_id: String,
    pub markdown: String,
    pub meta_json: String,
    pub created_at: String,
    pub attempts: i64,
    pub last_error: Option<String>,
}

/// Создаёт таблицу sync_queue если её нет.
pub async fn ensure_queue_table(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_queue (
            id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            markdown TEXT NOT NULL,
            meta_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Поставить транскрипт в очередь на отправку.
pub async fn enqueue_upload(
    pool: &SqlitePool,
    meeting_id: &str,
    markdown: &str,
    meta: &TranscriptMeta,
) -> Result<(), sqlx::Error> {
    ensure_queue_table(pool).await?;
    let meta_json = serde_json::to_string(meta).unwrap_or_default();
    let id = format!("queue-{}", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO sync_queue (id, meeting_id, markdown, meta_json, created_at, attempts)
         VALUES (?, ?, ?, ?, ?, 0)",
    )
    .bind(&id)
    .bind(meeting_id)
    .bind(markdown)
    .bind(&meta_json)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    info!(
        "Транскрипт {} положен в очередь sync_queue (id={})",
        meeting_id, id
    );
    Ok(())
}

/// Прочитать всё что лежит в очереди.
pub async fn list_queued(pool: &SqlitePool) -> Result<Vec<QueuedUpload>, sqlx::Error> {
    ensure_queue_table(pool).await?;
    let rows: Vec<QueuedUpload> =
        sqlx::query_as("SELECT id, meeting_id, markdown, meta_json, created_at, attempts, last_error FROM sync_queue ORDER BY created_at ASC")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

/// Удалить элемент из очереди.
pub async fn delete_queued(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sync_queue WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Зафиксировать ошибку отправки и увеличить счётчик попыток.
pub async fn mark_queued_failed(
    pool: &SqlitePool,
    id: &str,
    error: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?")
        .bind(error)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Сколько попыток с 4xx считаем permanent fail и удаляем запись из очереди.
/// 4xx (неверный ключ, битый payload) сам себя не починит при ретрае.
const MAX_FAILED_ATTEMPTS: i64 = 3;

/// Попробовать отправить всё что лежит в очереди.
///
/// Возвращает (sent, still_pending, failed_permanently).
///
/// Логика очистки: если запись 3+ раза получила 4xx — это не временная сетевая
/// проблема, а битый payload или старый ключ. Удаляем чтобы UI не показывал
/// «Не удалось отправить» вечно из-за одной зависшей записи.
pub async fn drain_queue(
    pool: &SqlitePool,
    server_url: &str,
    api_key: &str,
) -> (usize, usize, usize) {
    let queued = match list_queued(pool).await {
        Ok(q) => q,
        Err(e) => {
            error!("Не удалось прочитать sync_queue: {}", e);
            return (0, 0, 0);
        }
    };

    let mut sent = 0;
    let mut pending = 0;
    let mut failed = 0;

    for item in queued {
        // Если уже было слишком много 4xx — выкидываем без новой попытки
        if item.attempts >= MAX_FAILED_ATTEMPTS
            && item.last_error.as_deref().unwrap_or("").contains("4xx")
        {
            warn!(
                "sync_queue: удаляю мёртвую запись {} (meeting={}, attempts={})",
                item.id, item.meeting_id, item.attempts
            );
            let _ = delete_queued(pool, &item.id).await;
            continue;
        }

        let meta: TranscriptMeta = match serde_json::from_str(&item.meta_json) {
            Ok(m) => m,
            Err(e) => {
                error!("Битая мета в sync_queue {}: {}", item.id, e);
                let _ = delete_queued(pool, &item.id).await;
                continue;
            }
        };

        match upload_transcript(server_url, api_key, &item.markdown, &meta).await {
            Ok(SyncStatus::Sent) => {
                let _ = delete_queued(pool, &item.id).await;
                sent += 1;
            }
            Ok(SyncStatus::Failed) => {
                let _ = mark_queued_failed(pool, &item.id, "4xx от сервера").await;
                failed += 1;
            }
            Ok(SyncStatus::Pending) => {
                pending += 1;
            }
            Ok(SyncStatus::Disabled) => {
                pending += 1;
            }
            Err(e) => {
                let _ = mark_queued_failed(pool, &item.id, &e).await;
                pending += 1;
            }
        }
    }

    if sent > 0 || failed > 0 {
        info!(
            "Insapp queue drain: отправлено={}, ждёт={}, ошибок={}",
            sent, pending, failed
        );
    }

    (sent, pending, failed)
}

/// Полностью очистить очередь от записей с permanent-fail (4xx, attempts >= N).
/// Используется один раз при старте приложения чтобы зачистить мусор от прошлых
/// версий со старыми API-ключами.
pub async fn cleanup_dead_queue_entries(pool: &SqlitePool) -> usize {
    let queued = match list_queued(pool).await {
        Ok(q) => q,
        Err(_) => return 0,
    };

    let mut deleted = 0;
    for item in queued {
        if item.attempts >= MAX_FAILED_ATTEMPTS
            && item.last_error.as_deref().unwrap_or("").contains("4xx")
        {
            if delete_queued(pool, &item.id).await.is_ok() {
                deleted += 1;
                info!(
                    "Cleanup: удалена мёртвая запись очереди {} (meeting={})",
                    item.id, item.meeting_id
                );
            }
        }
    }
    deleted
}

/// Создаёт таблицу insapp_kv (key-value хранилище под наши настройки).
pub async fn ensure_kv_table(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS insapp_kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

const KV_SETTINGS: &str = "insapp_server_settings";

/// Загрузить настройки интеграции из БД (или вернуть дефолт).
pub async fn load_settings(pool: &SqlitePool) -> InsappServerSettings {
    if let Err(e) = ensure_kv_table(pool).await {
        warn!("Не удалось создать insapp_kv: {}", e);
        return InsappServerSettings::default();
    }

    let row: Result<Option<(String,)>, _> =
        sqlx::query_as("SELECT value FROM insapp_kv WHERE key = ?")
            .bind(KV_SETTINGS)
            .fetch_optional(pool)
            .await;

    match row {
        Ok(Some((json,))) => serde_json::from_str(&json).unwrap_or_default(),
        _ => InsappServerSettings::default(),
    }
}

/// Сохранить настройки интеграции в БД.
pub async fn save_settings(
    pool: &SqlitePool,
    settings: &InsappServerSettings,
) -> Result<(), sqlx::Error> {
    ensure_kv_table(pool).await?;
    let json = serde_json::to_string(settings).unwrap_or_default();
    sqlx::query(
        "INSERT INTO insapp_kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(KV_SETTINGS)
    .bind(&json)
    .execute(pool)
    .await?;
    Ok(())
}

/// Сводный статус, который удобно показать в UI.
#[derive(Debug, Serialize)]
pub struct InsappServerStatus {
    pub settings: InsappServerSettings,
    pub api_key_preview: String,
    pub key_source: String,
    pub queue_size: usize,
    pub server_reachable: Option<bool>,
    /// ФИО зарегистрированного пользователя (или пусто).
    pub full_name: String,
    /// Зарегистрирован ли пользователь (есть валидный ключ).
    pub is_registered: bool,
}

/// Собрать статус для UI (настройки + размер очереди + быстрый health check).
pub async fn build_status(pool: &SqlitePool) -> InsappServerStatus {
    let settings = load_settings(pool).await;
    let api_key = get_api_key();
    let preview = if api_key.len() >= 8 {
        format!("{}…{}", &api_key[..4], &api_key[api_key.len() - 4..])
    } else {
        "не задан".to_string()
    };
    let key_source_str = key_source().to_string();

    let queue_size = list_queued(pool).await.map(|q| q.len()).unwrap_or(0);

    // Быстрый health-check (2-секундный таймаут чтобы не подвешивать UI)
    let server_reachable = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => {
            let url = format!("{}/api/v1/health", settings.server_url.trim_end_matches('/'));
            match client.get(&url).send().await {
                Ok(r) => Some(r.status().is_success()),
                Err(_) => Some(false),
            }
        }
        Err(_) => None,
    };

    InsappServerStatus {
        settings,
        api_key_preview: preview,
        key_source: key_source_str,
        queue_size,
        server_reachable,
        full_name: get_full_name(),
        is_registered: is_registered(),
    }
}

/// Высокоуровневая функция: попробовать отправить, если не получилось - положить в очередь.
pub async fn upload_or_enqueue(
    pool: &SqlitePool,
    settings: &InsappServerSettings,
    api_key: &str,
    meeting_id: &str,
    meeting_title: &str,
    segments: &[TranscriptSegment],
) -> SyncStatus {
    if !settings.auto_upload {
        return SyncStatus::Disabled;
    }

    let duration_sec = segments
        .iter()
        .filter_map(|s| s.audio_end_time)
        .fold(0.0_f64, f64::max);
    let duration_sec = if duration_sec > 0.0 { Some(duration_sec) } else { None };

    let markdown = segments_to_markdown(meeting_title, segments);
    let meta = TranscriptMeta::for_transcript(meeting_id, meeting_title, duration_sec);

    match upload_transcript(&settings.server_url, api_key, &markdown, &meta).await {
        Ok(SyncStatus::Sent) => SyncStatus::Sent,
        Ok(SyncStatus::Failed) => {
            // Не кладём в очередь - сервер сказал что payload плохой
            SyncStatus::Failed
        }
        Ok(SyncStatus::Pending) | Err(_) => {
            // Сервер недоступен - в очередь
            if let Err(e) = enqueue_upload(pool, meeting_id, &markdown, &meta).await {
                error!("Не удалось положить транскрипт {} в очередь: {}", meeting_id, e);
                return SyncStatus::Failed;
            }
            SyncStatus::Pending
        }
        Ok(SyncStatus::Disabled) => SyncStatus::Disabled,
    }
}
