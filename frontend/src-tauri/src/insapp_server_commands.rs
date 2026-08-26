// Tauri-команды для UI - управление настройками сервера Insapp.

use tauri::{Runtime, State};

use crate::insapp_server::{
    self, drain_queue, get_or_create_api_key, set_api_key, InsappServerSettings,
    InsappServerStatus, SyncStatus,
};
use crate::state::AppState;

/// Разбирает markdown-транскрипт (формат segments_to_markdown) обратно в сегменты.
/// Строки вида "**[mm:ss]** текст" или "**[hh:mm:ss]** текст".
fn parse_markdown_to_segments(markdown: &str) -> Vec<crate::api::TranscriptSegment> {
    let re = regex::Regex::new(r"^\*\*\[([0-9:]+)\]\*\*\s*(.+)$").unwrap();
    // Имя участника в начале реплики: `**Иван:** текст` (новый формат с именами).
    // Старый формат (без имени) продолжает читаться как раньше.
    let re_speaker = regex::Regex::new(r"^\*\*([^*:]{1,60}):\*\*\s*(.*)$").unwrap();
    let mut segments = Vec::new();
    for line in markdown.lines() {
        let line = line.trim();
        if let Some(caps) = re.captures(line) {
            let ts = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let rest = caps.get(2).map(|m| m.as_str()).unwrap_or("").trim().to_string();
            // Отделяем имя участника от самого текста реплики.
            let (speaker_name, text) = match re_speaker.captures(&rest) {
                Some(sc) => (
                    sc.get(1).map(|m| m.as_str().trim().to_string()),
                    sc.get(2).map(|m| m.as_str()).unwrap_or("").trim().to_string(),
                ),
                None => (None, rest),
            };
            let _ = &speaker_name;
            if text.is_empty() {
                continue;
            }
            // mm:ss или hh:mm:ss → секунды
            let parts: Vec<f64> = ts.split(':').filter_map(|p| p.parse::<f64>().ok()).collect();
            let secs = match parts.len() {
                3 => parts[0] * 3600.0 + parts[1] * 60.0 + parts[2],
                2 => parts[0] * 60.0 + parts[1],
                1 => parts[0],
                _ => 0.0,
            };
            segments.push(crate::api::TranscriptSegment {
                id: format!("seg-{}", segments.len()),
                text,
                timestamp: ts.to_string(),
                audio_start_time: Some(secs),
                audio_end_time: None,
                duration: None,
                speaker: None,
            });
        }
    }
    segments
}

/// Синхронизация встреч из облака: тянет с сервера транскрипты ТЕКУЩЕЙ учётки
/// (сервер уже отдаёт только свои - изоляция по правам) и сохраняет локально те,
/// которых ещё нет (дедуп по названию). Так встречи "подтягиваются" на новое
/// устройство / после переустановки.
#[tauri::command]
pub async fn insapp_sync_from_server<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use crate::database::repositories::meeting::MeetingsRepository;
    use crate::database::repositories::transcript::TranscriptsRepository;
    use std::collections::HashSet;

    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;
    let api_key = insapp_server::get_api_key();
    if api_key.is_empty() {
        return Err("Сначала войди под своей учётной записью".to_string());
    }
    // Учётка владельца - под ней синхронизированные встречи сохранятся локально.
    let owner = insapp_server::get_full_name();

    let base = settings.server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    // 1. Список серверных транскриптов (сервер вернёт только доступные этой учётке)
    let list_url = format!("{}/api/v1/transcripts?limit=200", base);
    let resp = client
        .get(&list_url)
        .header("X-Insapp-Api-Key", &api_key)
        .send()
        .await
        .map_err(|e| format!("Не удалось получить список с сервера: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Сервер вернул {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {}", e))?;
    let empty = vec![];
    let items = json.get("items").and_then(|v| v.as_array()).unwrap_or(&empty);

    // 2. Локальные названия для дедупа (только свои - этой учётки)
    let local = MeetingsRepository::get_meetings(pool, Some(owner.as_str()))
        .await
        .map_err(|e| format!("Не удалось прочитать локальные встречи: {}", e))?;
    let local_titles: HashSet<String> = local.iter().map(|m| m.title.trim().to_string()).collect();

    let mut synced = 0usize;
    let total = items.len();

    for item in items {
        let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("transcript");
        if kind != "transcript" {
            continue; // summary тянем вместе с встречей отдельной логикой; здесь - транскрипты
        }
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if title.is_empty() || id.is_empty() || local_titles.contains(&title) {
            continue; // уже есть локально
        }

        // 3. markdown содержимое
        let md_url = format!("{}/api/v1/transcripts/{}?raw=1", base, id);
        let md = match client.get(&md_url).header("X-Insapp-Api-Key", &api_key).send().await {
            Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
            _ => continue,
        };
        let segments = parse_markdown_to_segments(&md);
        if segments.is_empty() {
            continue;
        }

        // 4. Сохраняем локально (repository напрямую - без обратной заливки на сервер)
        if TranscriptsRepository::save_transcript(pool, &title, &segments, None, Some(owner.as_str()))
            .await
            .is_ok()
        {
            synced += 1;
        }
    }

    // ОЧИСТКА ЧУЖИХ КОПИЙ (безопасная): удаляем локально СКАЧАННЫЕ встречи
    // (folder_path пустой = пришли с сервера, не записаны тут), которых сервер
    // БОЛЬШЕ не отдаёт этой учётке. После фикса изоляции сервер возвращает только
    // свои, поэтому скачанная встреча, которой нет в ответе - это чужая запись,
    // просочившаяся до фикса. Записанные локально (folder_path заполнен) НЕ трогаем -
    // они принадлежат владельцу и на сервере могут ещё не лежать.
    let server_titles: HashSet<String> = items
        .iter()
        .filter_map(|i| i.get("title").and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .collect();
    let mut purged = 0usize;
    for m in &local {
        let is_downloaded = m
            .folder_path
            .as_deref()
            .map(|p| p.trim().is_empty())
            .unwrap_or(true);
        if is_downloaded && !server_titles.contains(m.title.trim()) {
            if MeetingsRepository::delete_meeting(pool, &m.id).await.unwrap_or(false) {
                purged += 1;
            }
        }
    }
    if purged > 0 {
        tracing::warn!(
            "[insapp_sync] вычищено {} чужих скачанных встреч из локального кэша",
            purged
        );
    }

    tracing::info!(
        "[insapp_sync] synced={} из {} серверных, purged={}",
        synced, total, purged
    );
    Ok(serde_json::json!({ "synced": synced, "total": total, "purged": purged }))
}

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
    #[serde(rename = "login")]
    login: String,
    #[serde(rename = "role")]
    role: String,
    #[serde(rename = "deviceLabel")]
    device_label: String,
}

/// Вход на корпоративном сервере Insapp по логину и паролю (те же что для дашборда).
/// Шлёт login+password → сервер проверяет → выдаёт API-ключ привязанный к учётке →
/// клиент сохраняет ключ + логин. Используется в onboarding (первый запуск).
#[tauri::command]
pub async fn insapp_register_with_server<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    login: String,
    password: String,
    device_label: Option<String>,
) -> Result<serde_json::Value, String> {
    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;

    if login.trim().is_empty() || password.is_empty() {
        return Err("Введи логин и пароль".to_string());
    }

    let url = format!("{}/api/v1/clients/register", settings.server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let device = device_label.unwrap_or_else(|| {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "Mac".to_string())
    });

    let response = client
        .post(&url)
        .json(&serde_json::json!({
            "login": login.trim(),
            "password": password,
            "deviceLabel": device,
        }))
        .send()
        .await
        .map_err(|e| format!("Не удалось подключиться к серверу: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
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

    // Сохраняем ключ + логин (в поле full_name храним логин для отображения "вошёл как")
    insapp_server::set_credentials(&parsed.api_key, &parsed.login)
        .map_err(|e| format!("Не удалось сохранить ключ: {}", e))?;

    Ok(serde_json::json!({
        "registered": true,
        "login": parsed.login,
        "role": parsed.role,
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

    // Уважаем выбор пользователя «только локально»: если при сохранении галочка
    // «Отправить в облако» была снята, встреча помечена cloud_opt_out=1 и НЕ должна
    // уходить на сервер - ни при правке названия/типа, ни при AI-резюме, ни при
    // переотправке после стопа. Единая точка защиты для всех вызовов команды.
    match MeetingsRepository::get_cloud_opt_out(pool, &meeting_id).await {
        Ok(true) => {
            tracing::info!(
                "[insapp_resend] meeting={} помечена как локальная (галочка снята) - выгрузка пропущена",
                meeting_id
            );
            return Ok(serde_json::json!({
                "status": "disabled",
                "reason": "Встреча сохранена локально (галочка «Отправить в облако» снята)",
                "meeting_id": meeting_id,
            }));
        }
        Ok(false) => {}
        Err(e) => {
            // Не блокируем выгрузку из-за ошибки чтения флага - только логируем.
            tracing::warn!(
                "[insapp_resend] не удалось прочитать cloud_opt_out для {}: {}",
                meeting_id, e
            );
        }
    }

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
            speaker: t.speaker.clone(),
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

    // Имена участников, заданные пользователем - уходят на сервер вместе с текстом,
    // чтобы в дашборде и в скачанном файле было «Иван:», а не «Собеседник 1:».
    let names: std::collections::HashMap<String, String> =
        crate::database::repositories::transcript::TranscriptsRepository::get_speaker_names(pool, &meeting_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect();

    let markdown = insapp_server::segments_to_markdown_with_names(&meeting.title, &segments, &names);
    let mut meta = insapp_server::TranscriptMeta::for_transcript(&meeting_id, &meeting.title, duration_sec);
    meta.meeting_type = meeting.meeting_type.clone();

    let result = insapp_server::upload_transcript(&settings.server_url, &api_key, &markdown, &meta).await;

    let status_str = match result {
        Ok(insapp_server::SyncStatus::Sent) => "sent",
        Ok(insapp_server::SyncStatus::Pending) => "pending",
        Ok(insapp_server::SyncStatus::Failed) => "failed",
        Ok(insapp_server::SyncStatus::Disabled) => "disabled",
        Err(_) => "pending",
    };

    if matches!(result, Ok(insapp_server::SyncStatus::Sent)) {
        let _ = crate::database::repositories::meeting::MeetingsRepository::mark_synced(pool, &meeting_id, "transcript").await;
    }

    tracing::info!(
        "[insapp_resend] result for {}: {}",
        meeting_id, status_str
    );

    // Резюме - вторая половина встречи, и она обязана уезжать вместе с
    // расшифровкой. Раньше выгружался только транскрипт, поэтому у встреч
    // с уже готовым резюме публичная страница показывала «резюме ещё нет».
    let summary_status = sync_summary_to_server(pool, &meeting_id, &meeting.title, &settings, &api_key).await;

    Ok(serde_json::json!({
        "status": status_str,
        "summary_status": summary_status,
        "meeting_id": meeting_id,
    }))
}

/// Досыл на сервер всего, что есть локально, но отсутствует в облаке.
///
/// Зачем: расшифровки уезжали сразу после записи, а резюме - никогда, поэтому
/// у старых встреч публичная ссылка показывала «резюме ещё не сделано».
/// Команда сверяется со списком на сервере (по названию: расшифровка идёт под
/// названием встречи, резюме - под «Резюме: <название>») и отправляет недостающее.
/// Заодно проставляет честные отметки «загружено» тем встречам, которые на
/// сервере уже есть - без этого колонки статуса в списке врали бы.
///
/// Идемпотентна: повторный вызов ничего не дублирует.
#[tauri::command]
pub async fn insapp_sync_pending<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use crate::database::repositories::meeting::MeetingsRepository;
    use std::collections::HashSet;

    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;
    let api_key = insapp_server::get_api_key();
    if api_key.is_empty() || !settings.auto_upload {
        return Ok(serde_json::json!({ "status": "off" }));
    }

    let base = settings.server_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    // Что уже лежит на сервере.
    //
    // ВАЖНО: сервер отдаёт список порциями (максимум 200 записей за раз),
    // независимо от запрошенного limit. Если взять только первую порцию,
    // старые встречи в неё не попадут и будут считаться «отсутствующими» -
    // из-за этого часть резюме раньше не доезжала. Поэтому читаем постранично
    // до конца.
    let mut remote: HashSet<String> = HashSet::new();
    let mut offset = 0usize;
    loop {
        let resp = client
            .get(format!("{}/api/v1/transcripts?limit=200&offset={}", base, offset))
            .header("X-Insapp-Api-Key", &api_key)
            .send()
            .await
            .map_err(|e| format!("Сервер недоступен: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("Сервер вернул {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {}", e))?;
        let batch: Vec<String> = json
            .get("items")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|i| i.get("title").and_then(|t| t.as_str()))
                    .map(|s| s.trim().to_string())
                    .collect()
            })
            .unwrap_or_default();

        let got = batch.len();
        remote.extend(batch);
        if got < 200 || offset > 20_000 {
            break; // дошли до конца списка (страховка от бесконечного цикла)
        }
        offset += 200;
    }
    tracing::info!("[sync-pending] на сервере {} записей", remote.len());

    let owner = insapp_server::get_full_name();
    let meetings = MeetingsRepository::get_meetings(pool, Some(owner.as_str()))
        .await
        .map_err(|e| format!("Не удалось прочитать встречи: {}", e))?;

    let (mut sent_tr, mut sent_sum, mut marked, mut failed) = (0usize, 0usize, 0usize, 0usize);

    for m in &meetings {
        // Встречи «только локально» не трогаем - это осознанный выбор владельца.
        if MeetingsRepository::get_cloud_opt_out(pool, &m.id).await.unwrap_or(false) {
            continue;
        }

        let title = m.title.trim().to_string();
        let summary_title = format!("Резюме: {}", title);

        // --- расшифровка ---
        if remote.contains(&title) {
            if MeetingsRepository::mark_synced(pool, &m.id, "transcript").await.is_ok() {
                marked += 1;
            }
        } else {
            match insapp_upload_meeting_by_id(_app.clone(), state.clone(), m.id.clone()).await {
                Ok(v) if v.get("status").and_then(|s| s.as_str()) == Some("sent") => sent_tr += 1,
                Ok(_) => {}
                Err(_) => failed += 1,
            }
            // Выгрузка встречи сама тянет за собой резюме - дальше не дублируем.
            continue;
        }

        // --- резюме ---
        if remote.contains(&summary_title) {
            if MeetingsRepository::mark_synced(pool, &m.id, "summary").await.is_ok() {
                marked += 1;
            }
            // Пометка «в облаке» и внутри самого резюме - её читает экран встречи.
            mark_summary_sent_in_result(pool, &m.id).await;
        } else {
            match sync_summary_to_server(pool, &m.id, &title, &settings, &api_key).await {
                "sent" => sent_sum += 1,
                "failed" => failed += 1,
                _ => {}
            }
        }
    }

    tracing::info!(
        "[sync-pending] расшифровок {}, резюме {}, отмечено {}, ошибок {}",
        sent_tr, sent_sum, marked, failed
    );

    Ok(serde_json::json!({
        "status": "ok",
        "transcripts_sent": sent_tr,
        "summaries_sent": sent_sum,
        "marked": marked,
        "failed": failed,
    }))
}

/// Проставить в сохранённом резюме пометку «отправлено на сервер».
///
/// Экран встречи показывает чип «Резюме в облаке» по полю sync_status ВНУТРИ
/// JSON результата резюме - а пакетная генерация писала туда "pending" и после
/// успешной отправки никто это не обновлял. Получался рассинхрон: на главной
/// «Есть ✓», внутри встречи - «ещё не в облаке». Обновляем здесь, в единой
/// точке, для всех путей отправки.
pub(crate) async fn mark_summary_sent_in_result(pool: &sqlx::SqlitePool, meeting_id: &str) {
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT result FROM summary_processes
         WHERE meeting_id = ? AND status = 'completed' AND result IS NOT NULL AND result != ''
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let Some((result_json,)) = row else { return };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&result_json) else { return };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("sync_status".to_string(), serde_json::json!("sent"));
        obj.insert("synced_at".to_string(), serde_json::json!(chrono::Utc::now().to_rfc3339()));
    } else {
        return;
    }
    let _ = sqlx::query(
        "UPDATE summary_processes SET result = ? WHERE meeting_id = ? AND status = 'completed'",
    )
    .bind(v.to_string())
    .bind(meeting_id)
    .execute(pool)
    .await;
}

/// Отправить готовое резюме встречи на сервер.
///
/// Резюме хранится отдельно от расшифровки и на сервер уходит своей записью
/// (kind = "summary"). Функция общая для всех точек входа: авто-отправка после
/// записи, пакетная генерация, кнопка «Поделиться» и досыл старых встреч -
/// чтобы нигде не осталось пути, где резюме есть локально, но не на сервере.
///
/// Возвращает: "sent" | "none" (резюме нет) | "off" (выгрузка выключена) | "failed".
pub(crate) async fn sync_summary_to_server(
    pool: &sqlx::SqlitePool,
    meeting_id: &str,
    title: &str,
    settings: &insapp_server::InsappServerSettings,
    api_key: &str,
) -> &'static str {
    if !settings.auto_upload || api_key.is_empty() {
        return "off";
    }

    // Берём самое свежее готовое резюме встречи.
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT result FROM summary_processes
         WHERE meeting_id = ? AND status = 'completed' AND result IS NOT NULL AND result != ''
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let Some((result_json,)) = row else {
        return "none";
    };

    // В result лежит JSON, текст резюме - в поле markdown.
    let markdown = serde_json::from_str::<serde_json::Value>(&result_json)
        .ok()
        .and_then(|v| v.get("markdown").and_then(|m| m.as_str()).map(|s| s.to_string()))
        .unwrap_or(result_json);

    if markdown.trim().is_empty() {
        return "none";
    }

    let mut meta = insapp_server::TranscriptMeta::for_transcript(meeting_id, &format!("Резюме: {}", title), None);
    meta.kind = "summary".to_string();

    match insapp_server::upload_transcript(&settings.server_url, api_key, &markdown, &meta).await {
        Ok(insapp_server::SyncStatus::Sent) => {
            let _ = crate::database::repositories::meeting::MeetingsRepository::mark_synced(pool, meeting_id, "summary").await;
            mark_summary_sent_in_result(pool, meeting_id).await;
            tracing::info!("[sync-summary] резюме {} отправлено", meeting_id);
            "sent"
        }
        Ok(other) => {
            tracing::warn!("[sync-summary] резюме {} не ушло: {:?}", meeting_id, other);
            "failed"
        }
        Err(e) => {
            tracing::warn!("[sync-summary] резюме {} ошибка: {}", meeting_id, e);
            "failed"
        }
    }
}

/// Отправить ВСЕ встречи с транскриптами на сервер. Используется при первом
/// входе на новый сервер - переносит существующие заметки встреч. Идёт напрямую
/// через upload_transcript (не зависит от настройки auto_upload); что не
/// отправилось из-за недоступности сервера - кладётся в очередь на ретрай.
#[tauri::command]
pub async fn insapp_upload_all_meetings<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use crate::database::repositories::meeting::MeetingsRepository;

    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;
    let api_key = insapp_server::get_api_key();

    if api_key.is_empty() {
        return Err("Сначала войди под своей учётной записью".to_string());
    }

    // Заливаем на сервер только встречи текущей учётки.
    let owner = insapp_server::get_full_name();
    let meetings = MeetingsRepository::get_meetings(pool, Some(owner.as_str()))
        .await
        .map_err(|e| format!("Не удалось прочитать список встреч: {}", e))?;

    let mut total = 0usize;
    let mut sent = 0usize;
    let mut queued = 0usize;
    let mut skipped = 0usize;

    for m in &meetings {
        // НЕ заливаем обратно СКАЧАННЫЕ встречи (folder_path пустой = пришли с сервера
        // через синхронизацию, не записаны тут). Иначе чужие синхронизированные копии
        // уходят на сервер под нашей учёткой, и мы становимся «загрузившим» - это и есть
        // петля утечки: скачал чужое -> залил обратно -> видишь как своё.
        let is_downloaded = m
            .folder_path
            .as_deref()
            .map(|p| p.trim().is_empty())
            .unwrap_or(true);
        if is_downloaded {
            skipped += 1;
            continue;
        }
        let full = match MeetingsRepository::get_meeting(pool, &m.id).await {
            Ok(Some(f)) => f,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let segments: Vec<crate::api::TranscriptSegment> = full
            .transcripts
            .iter()
            .map(|t| crate::api::TranscriptSegment {
                id: t.id.clone(),
                text: t.text.clone(),
                timestamp: t.timestamp.clone(),
                audio_start_time: t.audio_start_time,
                audio_end_time: t.audio_end_time,
                duration: t.duration,
                speaker: t.speaker.clone(),
            })
            .collect();
        if segments.is_empty() {
            skipped += 1;
            continue;
        }
        total += 1;

        let duration_sec = segments
            .iter()
            .filter_map(|s| s.audio_end_time)
            .fold(0.0_f64, f64::max);
        let duration_sec = if duration_sec > 0.0 { Some(duration_sec) } else { None };

        let names: std::collections::HashMap<String, String> =
            crate::database::repositories::transcript::TranscriptsRepository::get_speaker_names(pool, &m.id)
                .await
                .unwrap_or_default()
                .into_iter()
                .collect();
        let markdown = insapp_server::segments_to_markdown_with_names(&full.title, &segments, &names);
        let mut meta = insapp_server::TranscriptMeta::for_transcript(&m.id, &full.title, duration_sec);
        meta.meeting_type = full.meeting_type.clone();

        match insapp_server::upload_transcript(&settings.server_url, &api_key, &markdown, &meta).await {
            Ok(SyncStatus::Sent) => sent += 1,
            Ok(SyncStatus::Pending) | Err(_) => {
                // Сервер недоступен - в очередь на ретрай
                let _ = insapp_server::enqueue_upload(pool, &m.id, &markdown, &meta).await;
                queued += 1;
            }
            Ok(_) => {}
        }
    }

    tracing::info!(
        "[insapp_upload_all] total={} sent={} queued={} skipped={}",
        total, sent, queued, skipped
    );

    Ok(serde_json::json!({
        "total": total,
        "sent": sent,
        "queued": queued,
        "skipped": skipped,
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
    // Логируем только ДЛИНУ ключа, не его начало (а) без утечки части секрета в логи,
    // (б) без паники: байтовый срез &api_key[..8] падал если ключ введён вручную и
    // содержит многобайтовый символ (кириллицу) - крашил Tauri-процесс.
    tracing::info!(
        "[insapp_upload] API key найден (длина {}), segments={}, начинаю upload",
        api_key.chars().count(),
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

/// «Поделиться встречей»: получить публичную ссылку на расшифровку.
///
/// Встреча должна быть на сервере - если её там ещё нет, сначала выгружаем.
/// Возвращает адрес вида https://<сервер>/s/<токен>: он открывается у любого
/// без пароля. Повторный вызов возвращает ту же ссылку, а не плодит новые.
#[tauri::command]
pub async fn insapp_share_meeting<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<serde_json::Value, String> {
    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;
    let api_key = insapp_server::get_api_key();
    if api_key.is_empty() {
        return Err("Сначала войди под своей учётной записью".to_string());
    }

    // Гарантируем, что встреча есть на сервере (иначе делиться нечем).
    // Уважает галочку «только локально»: там команда сама вернёт disabled.
    let upload = insapp_upload_meeting_by_id(app, state.clone(), meeting_id.clone()).await;
    if let Ok(v) = &upload {
        if v.get("status").and_then(|s| s.as_str()) == Some("disabled") {
            return Err(
                "Эта встреча сохранена только локально - чтобы поделиться, включи отправку в облако"
                    .to_string(),
            );
        }
    }

    let base = settings.server_url.trim_end_matches('/').to_string();
    let url = format!("{}/api/v1/meetings/{}/share", base, meeting_id);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    // Content-Type обязателен: без него сервер отвечает 400 на POST без тела
    // (поймано тестом - кнопка «Поделиться» молча падала).
    let resp = client
        .post(&url)
        .header("X-Insapp-Api-Key", &api_key)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("Сервер недоступен: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Сервер вернул {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {}", e))?;
    tracing::info!("[share] ссылка для встречи {} получена", meeting_id);
    Ok(json)
}

/// Принять от фронта замеры уровня звука за прошедшую запись и, если звук
/// не захватывался (микрофон и/или система молчали), отправить диагностику
/// на сервер. Тихо выходит, если звук был нормальный или нет API-ключа.
#[tauri::command]
pub async fn send_audio_diagnostic(
    state: State<'_, AppState>,
    mic_device: String,
    system_device: String,
    mic_max_rms: f32,
    system_max_rms: f32,
    level_events: i64,
    duration_sec: f64,
) -> Result<(), String> {
    // Порог тишины: ниже него считаем, что звука фактически не было.
    const SILENCE_RMS: f32 = 0.001;
    let mic_silent = mic_max_rms < SILENCE_RMS;
    let system_silent = system_max_rms < SILENCE_RMS;

    // Всё хорошо - хотя бы один источник дал звук. Ничего не шлём.
    if !mic_silent && !system_silent {
        return Ok(());
    }

    let api_key = insapp_server::get_api_key();
    if api_key.is_empty() {
        // Без ключа отправлять некуда - тихо выходим.
        return Ok(());
    }
    let pool = state.db_manager.pool();
    let settings = insapp_server::load_settings(pool).await;

    let note = match (mic_silent, system_silent) {
        (true, true) => "И микрофон, и системный звук молчали всю запись (звук не захватился)".to_string(),
        (true, false) => "Микрофон молчал всю запись (системный звук был)".to_string(),
        (false, true) => "Системный звук молчал всю запись (микрофон был)".to_string(),
        _ => String::new(),
    };

    let diag = insapp_server::AudioDiagnostic {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        mic_device,
        system_device,
        mic_max_rms,
        system_max_rms,
        mic_silent,
        system_silent,
        level_events,
        duration_sec,
        note,
    };

    tracing::warn!(
        "[audio_diag] тишина: mic_rms={:.5} sys_rms={:.5} events={} -> отправляю на сервер",
        mic_max_rms, system_max_rms, level_events
    );
    insapp_server::send_diagnostic(&settings.server_url, &api_key, &diag).await
}
