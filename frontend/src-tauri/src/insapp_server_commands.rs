// Tauri-команды для UI - управление настройками сервера Insapp.

use tauri::{Runtime, State};

use crate::insapp_server::{
    self, drain_queue, get_or_create_api_key, set_api_key, InsappServerSettings,
    InsappServerStatus, SyncStatus,
};
use crate::state::AppState;

#[tauri::command]
pub async fn insapp_get_status<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<InsappServerStatus, String> {
    let pool = state.db_manager.pool();
    Ok(insapp_server::build_status(pool).await)
}

#[tauri::command]
pub async fn insapp_save_settings<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    server_url: String,
    auto_upload: bool,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let settings = InsappServerSettings {
        server_url,
        auto_upload,
    };
    insapp_server::save_settings(pool, &settings)
        .await
        .map_err(|e| format!("Не удалось сохранить настройки сервера: {}", e))
}

#[tauri::command]
pub async fn insapp_get_api_key<R: Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<String, String> {
    get_or_create_api_key()
}

/// Удалить API-ключ (на случай если пользователь хочет ввести новый).
#[tauri::command]
pub async fn insapp_regenerate_api_key<R: Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<String, String> {
    let _ = insapp_server::delete_api_key();
    Ok(String::new())
}

#[tauri::command]
pub async fn insapp_set_api_key<R: Runtime>(
    _app: tauri::AppHandle<R>,
    api_key: String,
) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API-ключ не может быть пустым".to_string());
    }
    set_api_key(api_key.trim())
}

#[derive(serde::Deserialize)]
struct RegisterResponse {
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(rename = "fullName")]
    full_name: String,
    #[serde(rename = "deviceLabel")]
    device_label: String,
}

/// Self-registration на корпоративном сервере Insapp.
/// Шлёт ФИО → получает API ключ → сохраняет его автоматически.
/// Используется в onboarding (первый запуск приложения).
#[tauri::command]
pub async fn insapp_register_with_server<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    full_name: String,
    device_label: Option<String>,
) -> Result<serde_json::Value, String> {
    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;

    if full_name.trim().is_empty() {
        return Err("Введи имя и фамилию".to_string());
    }

    let url = format!("{}/api/v1/clients/register", settings.server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let device = device_label.unwrap_or_else(|| {
        let hostname = std::process::Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "Mac".to_string());
        hostname
    });

    let response = client
        .post(&url)
        .json(&serde_json::json!({
            "fullName": full_name.trim(),
            "deviceLabel": device,
        }))
        .send()
        .await
        .map_err(|e| format!("Не удалось подключиться к серверу: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        // Парсим ошибку из server response для дружелюбного сообщения
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
                return Err(err.to_string());
            }
        }
        return Err(format!("Сервер вернул ошибку {}: {}", status, text));
    }

    let parsed: RegisterResponse = response
        .json()
        .await
        .map_err(|e| format!("Не удалось разобрать ответ сервера: {}", e))?;

    insapp_server::set_credentials(&parsed.api_key, &parsed.full_name)
        .map_err(|e| format!("Не удалось сохранить ключ: {}", e))?;

    Ok(serde_json::json!({
        "registered": true,
        "full_name": parsed.full_name,
        "device_label": parsed.device_label,
    }))
}

/// Кто сейчас зарегистрирован - для onboarding gate и Настроек.
#[tauri::command]
pub async fn insapp_get_identity<R: Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "full_name": insapp_server::get_full_name(),
        "is_registered": insapp_server::is_registered(),
    }))
}

/// Принудительно прогнать очередь (UI кнопка "Отправить сейчас").
#[tauri::command]
pub async fn insapp_flush_queue<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;
    let api_key = get_or_create_api_key()?;

    let (sent, pending, failed) = drain_queue(pool, &settings.server_url, &api_key).await;

    Ok(serde_json::json!({
        "sent": sent,
        "pending": pending,
        "failed": failed,
    }))
}

/// Точечная отправка одной встречи на сервер. Берёт транскрипты из локальной БД
/// и шлёт их напрямую (минуя очередь). Вызывается из UI кнопкой
/// «Отправить транскрипт на сервер» в карточке встречи — гарантирует что
/// отправится именно ЭТА встреча, а не зависшая запись очереди от прошлых версий.
///
/// Возвращает {"status": "sent"|"pending"|"failed"|"disabled"} для индикации в UI.
#[tauri::command]
pub async fn insapp_upload_meeting_by_id<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<serde_json::Value, String> {
    use crate::database::repositories::meeting::MeetingsRepository;

    let pool = state.db_manager.pool();

    // 1) Достаём встречу со всеми сегментами
    let meeting = MeetingsRepository::get_meeting(pool, &meeting_id)
        .await
        .map_err(|e| format!("Не удалось прочитать встречу: {}", e))?
        .ok_or_else(|| format!("Встреча {} не найдена", meeting_id))?;

    // 2) Преобразуем в формат TranscriptSegment
    let segments: Vec<crate::api::TranscriptSegment> = meeting
        .transcripts
        .iter()
        .map(|t| crate::api::TranscriptSegment {
            id: t.id.clone(),
            text: t.text.clone(),
            timestamp: t.timestamp.clone(),
            audio_start_time: t.audio_start_time,
            audio_end_time: t.audio_end_time,
            duration: t.duration,
        })
        .collect();

    if segments.is_empty() {
        return Ok(serde_json::json!({
            "status": "failed",
            "reason": "У встречи нет сегментов транскрипта",
        }));
    }

    // 3) Шлём через try_upload_meeting (auto_upload uses settings; force=true игнорирует setting)
    let settings = insapp_server::load_settings(pool).await;
    let api_key = insapp_server::get_api_key();

    tracing::info!(
        "[insapp_resend] meeting={} title='{}' segments={} server={} key={}...",
        meeting_id,
        meeting.title,
        segments.len(),
        settings.server_url,
        &api_key[..api_key.len().min(8)]
    );

    if api_key.is_empty() {
        return Ok(serde_json::json!({
            "status": "failed",
            "reason": "API-ключ не найден",
        }));
    }

    // Отправляем напрямую через upload_transcript (без очереди — пользователь жмёт «отправить сейчас»)
    let duration_sec = segments
        .iter()
        .filter_map(|s| s.audio_end_time)
        .fold(0.0_f64, f64::max);
    let duration_sec = if duration_sec > 0.0 { Some(duration_sec) } else { None };

    let markdown = insapp_server::segments_to_markdown(&meeting.title, &segments);
    let meta = insapp_server::TranscriptMeta::for_transcript(&meeting_id, &meeting.title, duration_sec);

    let result = insapp_server::upload_transcript(&settings.server_url, &api_key, &markdown, &meta).await;

    let status_str = match result {
        Ok(insapp_server::SyncStatus::Sent) => "sent",
        Ok(insapp_server::SyncStatus::Pending) => "pending",
        Ok(insapp_server::SyncStatus::Failed) => "failed",
        Ok(insapp_server::SyncStatus::Disabled) => "disabled",
        Err(_) => "pending",
    };

    tracing::info!(
        "[insapp_resend] result for {}: {}",
        meeting_id, status_str
    );

    Ok(serde_json::json!({
        "status": status_str,
        "meeting_id": meeting_id,
    }))
}

/// Отправить один транскрипт прямо сейчас (используется внутренне после save_transcript).
pub async fn try_upload_meeting<R: Runtime>(
    _app: &tauri::AppHandle<R>,
    state: &AppState,
    meeting_id: &str,
    meeting_title: &str,
    segments: &[crate::api::TranscriptSegment],
) -> SyncStatus {
    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;
    tracing::info!(
        "[insapp_upload] meeting={} title='{}' server_url={} auto_upload={}",
        meeting_id, meeting_title, settings.server_url, settings.auto_upload
    );
    let api_key = insapp_server::get_api_key();
    if api_key.is_empty() {
        tracing::warn!(
            "[insapp_upload] API key не задан - встреча {} не отправлена (настрой ключ в Настройки → Сервер Insapp). File: ~/Library/Application Support/tech.insap.meet/insapp-credentials.json",
            meeting_id
        );
        return SyncStatus::Failed;
    }
    tracing::info!(
        "[insapp_upload] API key найден ({}...), segments={}, начинаю upload",
        &api_key[..api_key.len().min(8)],
        segments.len()
    );

    let result = insapp_server::upload_or_enqueue(
        pool,
        &settings,
        &api_key,
        meeting_id,
        meeting_title,
        segments,
    )
    .await;
    tracing::info!("[insapp_upload] result for {}: {:?}", meeting_id, result);
    result
}
