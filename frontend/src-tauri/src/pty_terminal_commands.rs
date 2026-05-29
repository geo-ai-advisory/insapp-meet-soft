// Tauri-команды для pty_terminal и для запуска AI summary.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{Emitter, Manager, Runtime, State};

use crate::pty_terminal::{PtyManager, SpawnRequest};
use crate::state::AppState;

#[tauri::command]
pub async fn pty_spawn<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, Arc<PtyManager>>,
    request: SpawnRequest,
) -> Result<String, String> {
    state.spawn(
        app,
        request.command,
        request.args,
        request.cwd,
        request.cols,
        request.rows,
        request.env,
    )
}

#[tauri::command]
pub async fn pty_write<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<PtyManager>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub async fn pty_resize<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<PtyManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&session_id, cols, rows)
}

#[tauri::command]
pub async fn pty_kill<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<PtyManager>>,
    session_id: String,
) -> Result<(), String> {
    state.kill(&session_id)
}

// ============================================================
// Настройки AI-резюме (хранятся в insapp_kv)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSummarySettings {
    /// Какой CLI-инструмент запускать: "claude", "codex", "custom"
    pub provider: String,
    /// Полная команда (для custom). Для claude/codex - имя в PATH.
    pub command: String,
    /// Аргументы (полезно для custom). Для claude/codex - можно пустые.
    pub args: Vec<String>,
    /// Формат передачи транскрипта: "markdown" или "json"
    pub format: String,
    /// Шаблон промпта.
    pub prompt_template: String,
    /// Использовать ли --print флаг (для claude/codex), чтобы получить stdout (а не интерактив).
    pub use_print_mode: bool,
}

impl Default for AiSummarySettings {
    fn default() -> Self {
        Self {
            provider: "claude".to_string(),
            command: "claude".to_string(),
            args: vec![],
            format: "markdown".to_string(),
            prompt_template: DEFAULT_PROMPT.to_string(),
            // claude провайдер всегда использует --print + bypassPermissions
            // (см. build_cli_invocation). Флаг оставлен для custom-команд.
            use_print_mode: true,
        }
    }
}

// Архитектура:
// 1. claude запускается в TUI режиме - обычный интерактивный чат
// 2. Начальный промпт автоматически вводится через pty_write (bracketed paste)
// 3. AI выводит markdown резюме в чат, пользователь может править ("сократи раздел X")
// 4. Когда пользователь нажимает "Сохранить как резюме":
//    a. Frontend вызывает ai_summary_request_save
//    b. Backend через pty_write шлёт AI команду: "запиши финальную версию в файл <path>"
//    c. AI пишет файл через tool Write, отвечает "СОХРАНЕНО"
//    d. Backend polling-ом ждёт появления файла (до 30 сек)
//    e. Backend читает файл и возвращает markdown
//    f. Frontend вызывает ai_summary_save_result → БД + сервер + event
// 5. Файл - единственный источник истины. Никакой парсинг буфера не используется.
const DEFAULT_PROMPT: &str = "Сделай структурированное деловое резюме встречи на русском языке.\n\
\n\
Транскрипт встречи лежит в файле: {file}\n\
Прочитай его (можешь использовать tool Read) и выведи в чат markdown-резюме со структурой:\n\
\n\
## Цель встречи\n\
(одно-два предложения)\n\
\n\
## Ключевые темы\n\
- ...\n\
- ...\n\
\n\
## Принятые решения\n\
- ...\n\
\n\
## Action items\n\
1. <что сделать> - <кто> - <срок если ясно>\n\
2. ...\n\
\n\
ВАЖНО: не добавляй заголовок типа \"# Резюме: ...\" в начало - название встречи уже отображается в карточке. \
Начни сразу с \"## Цель встречи\".\n\
\n\
Пиши кратко, по-деловому, по-русски. Никаких маркеров - просто markdown в чат.\n\
\n\
После вывода я могу попросить правки (\"сократи\", \"добавь раздел Х\", \"перепиши action items\"). \
Выведи новую версию когда попрошу. Когда я нажму \"Сохранить как резюме\" - ты получишь команду записать \
финальную версию в файл, после этого нужно использовать tool Write для записи.";

const KV_AI_SETTINGS: &str = "ai_summary_settings";

async fn ensure_kv(pool: &SqlitePool) {
    let _ = crate::insapp_server::ensure_kv_table(pool).await;
}

pub async fn load_ai_settings(pool: &SqlitePool) -> AiSummarySettings {
    ensure_kv(pool).await;
    let row: Result<Option<(String,)>, _> =
        sqlx::query_as("SELECT value FROM insapp_kv WHERE key = ?")
            .bind(KV_AI_SETTINGS)
            .fetch_optional(pool)
            .await;
    match row {
        Ok(Some((json,))) => serde_json::from_str(&json).unwrap_or_default(),
        _ => AiSummarySettings::default(),
    }
}

pub async fn save_ai_settings(
    pool: &SqlitePool,
    s: &AiSummarySettings,
) -> Result<(), sqlx::Error> {
    ensure_kv(pool).await;
    let json = serde_json::to_string(s).unwrap_or_default();
    sqlx::query(
        "INSERT INTO insapp_kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(KV_AI_SETTINGS)
    .bind(&json)
    .execute(pool)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn ai_summary_get_settings<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<AiSummarySettings, String> {
    let pool = state.db_manager.pool();
    Ok(load_ai_settings(pool).await)
}

#[tauri::command]
pub async fn ai_summary_save_settings<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    settings: AiSummarySettings,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    save_ai_settings(pool, &settings)
        .await
        .map_err(|e| format!("Не удалось сохранить настройки AI-резюме: {}", e))
}

/// Проверить наличие CLI в PATH (через which).
#[tauri::command]
pub async fn ai_summary_check_cli<R: Runtime>(
    _app: tauri::AppHandle<R>,
    command: String,
) -> Result<Option<String>, String> {
    // Если absolute path и existst - вернуть его
    let p = std::path::Path::new(&command);
    if p.is_absolute() && p.exists() {
        return Ok(Some(command));
    }

    // Иначе ищем в PATH
    if let Ok(path) = which::which(&command) {
        Ok(Some(path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

// ============================================================
// "Сделать AI-резюме": подготовка транскрипта и запуск pty.
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummarySessionStart {
    pub session_id: String,
    pub temp_file: String,
    pub command: String,
    pub args: Vec<String>,
}

#[tauri::command]
pub async fn ai_summary_start<R: Runtime>(
    app: tauri::AppHandle<R>,
    state_app: State<'_, AppState>,
    state_pty: State<'_, Arc<PtyManager>>,
    meeting_id: String,
    cols: u16,
    rows: u16,
) -> Result<SummarySessionStart, String> {
    let pool = state_app.db_manager.pool();
    let settings = load_ai_settings(pool).await;

    // 1. Достаём транскрипт из БД
    let transcript_rows: Vec<(String, String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT transcript, timestamp, audio_start_time, audio_end_time
         FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time ASC NULLS LAST, timestamp ASC",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Не удалось прочитать транскрипт: {}", e))?;

    if transcript_rows.is_empty() {
        return Err("Транскрипт встречи пуст".to_string());
    }

    // 2. Получаем title
    let meeting: Option<(String,)> =
        sqlx::query_as("SELECT title FROM meetings WHERE id = ?")
            .bind(&meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("meeting fetch: {}", e))?;
    let title = meeting.map(|(t,)| t).unwrap_or_else(|| "Встреча".into());

    // 3. Формируем payload в выбранном формате
    let payload = if settings.format == "json" {
        let segments: Vec<serde_json::Value> = transcript_rows
            .iter()
            .map(|(text, timestamp, start, end)| {
                serde_json::json!({
                    "text": text,
                    "timestamp": timestamp,
                    "audio_start_time": start,
                    "audio_end_time": end,
                })
            })
            .collect();
        serde_json::to_string_pretty(&serde_json::json!({
            "title": title,
            "segments": segments,
        }))
        .unwrap_or_default()
    } else {
        let mut buf = format!("# {}\n\n", title);
        for (text, timestamp, start, _end) in &transcript_rows {
            let ts = start
                .map(format_ts)
                .unwrap_or_else(|| timestamp.clone());
            buf.push_str(&format!("**[{}]** {}\n\n", ts, text.trim()));
        }
        buf
    };

    // 4. Пишем во временный файл (в app_data_dir/temp)
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    let temp_dir = app_data.join("ai-summary-temp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("mkdir temp: {}", e))?;
    let ext = if settings.format == "json" { "json" } else { "md" };
    let temp_file = temp_dir.join(format!("{}.{}", meeting_id, ext));
    std::fs::write(&temp_file, payload).map_err(|e| format!("write temp: {}", e))?;

    // 4.5. Создаём папку summaries и путь куда AI запишет резюме.
    // Перед стартом удаляем старый файл если есть - чтобы потом точно знать
    // что AI создал свежий, а не остался прошлый.
    let summaries_dir = app_data.join("summaries");
    std::fs::create_dir_all(&summaries_dir).map_err(|e| format!("mkdir summaries: {}", e))?;
    let output_file = summaries_dir.join(format!("{}.md", meeting_id));
    let _ = std::fs::remove_file(&output_file);

    // 5. Готовим команду. Claude запускается в TUI режиме (без --print) -
    // чтобы пользователь мог давать правки в чат после первого ответа.
    // Промпт автоматически вводится через pty_write после задержки.
    let (cmd, args, full_prompt) =
        build_cli_invocation(&settings, &temp_file, &output_file, &title);

    // 6. Запускаем pty
    let mut env = HashMap::new();
    env.insert(
        "INSAPP_MEETING_ID".to_string(),
        meeting_id.clone(),
    );
    env.insert("INSAPP_MEETING_TITLE".to_string(), title.clone());
    env.insert("INSAPP_SUMMARY_OUTPUT".to_string(), output_file.to_string_lossy().to_string());

    let session_id = state_pty.spawn(
        app.clone(),
        cmd.clone(),
        args.clone(),
        None,
        cols,
        rows,
        env,
    )?;

    // 7. Через 2.5 сек "набираем" промпт в claude через bracketed paste:
    // escape-последовательности \x1b[200~ ... \x1b[201~ говорят терминалу
    // что это вставленный текст, а не интерактивный ввод. Это даёт claude
    // принять многострочный промпт как одно сообщение. В конце \r - Enter.
    if matches!(settings.provider.as_str(), "claude" | "codex") && !full_prompt.is_empty() {
        let pty_manager = state_pty.inner().clone();
        let session_id_clone = session_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
            let payload = format!("\x1b[200~{}\x1b[201~\r", full_prompt);
            let _ = pty_manager.write(&session_id_clone, payload.as_bytes());
        });
    }

    Ok(SummarySessionStart {
        session_id,
        temp_file: temp_file.to_string_lossy().to_string(),
        command: cmd,
        args,
    })
}

fn format_ts(seconds: f64) -> String {
    let t = seconds as u64;
    let h = t / 3600;
    let m = (t % 3600) / 60;
    let s = t % 60;
    if h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

/// Сохранить markdown-резюме встречи в локальную БД и отправить на сервер Insapp.
#[tauri::command]
pub async fn ai_summary_save_result<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    summary_markdown: String,
) -> Result<serde_json::Value, String> {
    let pool = state.db_manager.pool();
    let now = chrono::Utc::now().to_rfc3339();

    // Отправляем на сервер Insapp (как summary kind) ДО записи в БД,
    // чтобы вписать актуальный sync_status в JSON и UI окна митинга видел
    // его сразу при fetchMeetingSummary - не пришлось перезапрашивать.
    let settings = crate::insapp_server::load_settings(pool).await;
    let api_key = crate::insapp_server::get_api_key();

    let title: Option<(String,)> =
        sqlx::query_as("SELECT title FROM meetings WHERE id = ?")
            .bind(&meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("title fetch: {}", e))?;
    let title = title.map(|(t,)| t).unwrap_or_else(|| "Встреча".to_string());

    let mut meta = crate::insapp_server::TranscriptMeta::for_transcript(
        &meeting_id,
        &format!("Резюме: {}", title),
        None,
    );
    meta.kind = "summary".to_string();

    let sync_status = if settings.auto_upload && !api_key.is_empty() {
        match crate::insapp_server::upload_transcript(
            &settings.server_url,
            &api_key,
            &summary_markdown,
            &meta,
        )
        .await
        {
            Ok(s) => s,
            Err(_) => crate::insapp_server::SyncStatus::Pending,
        }
    } else {
        crate::insapp_server::SyncStatus::Disabled
    };

    let sync_status_str = match sync_status {
        crate::insapp_server::SyncStatus::Sent => "sent",
        crate::insapp_server::SyncStatus::Pending => "pending",
        crate::insapp_server::SyncStatus::Failed => "failed",
        crate::insapp_server::SyncStatus::Disabled => "disabled",
    };

    // Записываем в summary_processes как result + status=completed.
    // Поле "markdown" - frontend api_get_summary читает именно его
    // (см. fetchMeetingSummary в meeting-details/page.tsx -> parsedData.markdown).
    // Поле "sync_status" - чтобы UI окна митинга показал badge статуса
    // отправки на сервер (а не только в терминале).
    let result_json = serde_json::json!({
        "markdown": summary_markdown,
        "format": "markdown",
        "source": "ai_terminal",
        "sync_status": sync_status_str,
        "synced_at": &now,
    })
    .to_string();

    sqlx::query(
        "INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result)
         VALUES (?, 'completed', ?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET
            status = 'completed',
            updated_at = excluded.updated_at,
            result = excluded.result",
    )
    .bind(&meeting_id)
    .bind(&now)
    .bind(&now)
    .bind(&result_json)
    .execute(pool)
    .await
    .map_err(|e| format!("Не удалось сохранить резюме в БД: {}", e))?;

    let _ = app.emit("ai-summary-saved", &meeting_id);

    Ok(serde_json::json!({
        "saved": true,
        "sync_status": sync_status_str,
    }))
}

/// Точечно переотправить уже сохранённое резюме на сервер
/// (например, если auto_upload был выключен или сервер был недоступен).
/// Берёт markdown из summary_processes.result, шлёт, обновляет sync_status.
#[tauri::command]
pub async fn ai_summary_resend_to_server<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<serde_json::Value, String> {
    let pool = state.db_manager.pool();

    let row: Option<(String,)> =
        sqlx::query_as("SELECT result FROM summary_processes WHERE meeting_id = ?")
            .bind(&meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Не удалось прочитать резюме: {}", e))?;

    let result_str = row
        .map(|(r,)| r)
        .ok_or_else(|| "Резюме не найдено".to_string())?;

    let mut parsed: serde_json::Value = serde_json::from_str(&result_str)
        .map_err(|e| format!("Не удалось распарсить result: {}", e))?;

    let markdown = parsed
        .get("markdown")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "В резюме нет поля markdown".to_string())?
        .to_string();

    let title: Option<(String,)> =
        sqlx::query_as("SELECT title FROM meetings WHERE id = ?")
            .bind(&meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("title fetch: {}", e))?;
    let title = title.map(|(t,)| t).unwrap_or_else(|| "Встреча".to_string());

    let api_key = crate::insapp_server::get_api_key();
    if api_key.is_empty() {
        return Err("Не задан API-ключ Insapp (Настройки -> Сервер Insapp)".to_string());
    }
    let settings = crate::insapp_server::load_settings(pool).await;

    let mut meta = crate::insapp_server::TranscriptMeta::for_transcript(
        &meeting_id,
        &format!("Резюме: {}", title),
        None,
    );
    meta.kind = "summary".to_string();

    let sync_status = match crate::insapp_server::upload_transcript(
        &settings.server_url,
        &api_key,
        &markdown,
        &meta,
    )
    .await
    {
        Ok(s) => s,
        Err(_) => crate::insapp_server::SyncStatus::Failed,
    };

    let sync_status_str = match sync_status {
        crate::insapp_server::SyncStatus::Sent => "sent",
        crate::insapp_server::SyncStatus::Pending => "pending",
        crate::insapp_server::SyncStatus::Failed => "failed",
        crate::insapp_server::SyncStatus::Disabled => "disabled",
    };

    let now = chrono::Utc::now().to_rfc3339();
    if let Some(obj) = parsed.as_object_mut() {
        obj.insert("sync_status".into(), serde_json::Value::String(sync_status_str.into()));
        obj.insert("synced_at".into(), serde_json::Value::String(now.clone()));
    }
    let new_result = parsed.to_string();

    sqlx::query(
        "UPDATE summary_processes SET result = ?, updated_at = ? WHERE meeting_id = ?",
    )
    .bind(&new_result)
    .bind(&now)
    .bind(&meeting_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Не удалось обновить sync_status: {}", e))?;

    let _ = app.emit("ai-summary-saved", &meeting_id);

    Ok(serde_json::json!({
        "sync_status": sync_status_str,
    }))
}

fn build_cli_invocation(
    settings: &AiSummarySettings,
    transcript_path: &PathBuf,
    output_path: &PathBuf,
    title: &str,
) -> (String, Vec<String>, String) {
    let output_str = output_path.to_string_lossy().to_string();
    let transcript_str = transcript_path.to_string_lossy().to_string();
    let prompt = settings
        .prompt_template
        .replace("{title}", title)
        .replace("{file}", &transcript_str)
        .replace("{output}", &output_str);

    match settings.provider.as_str() {
        "claude" => {
            // claude в TUI режиме - пользователь видит интерактивный чат.
            // --add-dir на обе папки (транскрипт для Read, summaries для Write позже)
            // --permission-mode bypassPermissions - чтобы tool Write при Save сработал
            //   без интерактивного диалога "разрешить?"
            // --allowedTools Write,Read - явный whitelist
            let transcript_dir = transcript_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let summaries_dir = output_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let args = vec![
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--add-dir".to_string(),
                transcript_dir,
                "--add-dir".to_string(),
                summaries_dir,
                "--allowedTools".to_string(),
                "Write,Read".to_string(),
            ];
            (settings.command.clone(), args, prompt)
        }
        "codex" => {
            // Codex CLI в интерактивном режиме
            let args = vec![];
            (settings.command.clone(), args, prompt)
        }
        _ => {
            // custom - пробрасываем как есть, добавляем путь файла в конец
            let mut args = settings.args.clone();
            args.push(transcript_str);
            (settings.command.clone(), args, prompt)
        }
    }
}

/// Через pty_write шлёт AI команду записать финальную версию в файл и polling-ом
/// ждёт появления файла. Возвращает прочитанный markdown.
///
/// Вызывается когда пользователь нажимает "Сохранить как резюме" - так файл
/// создаётся ПО ЗАПРОСУ пользователя, а не сразу. До этого AI просто общается
/// в чате как обычно.
#[tauri::command]
pub async fn ai_summary_request_save<R: Runtime>(
    app: tauri::AppHandle<R>,
    state_pty: State<'_, Arc<PtyManager>>,
    session_id: String,
    meeting_id: String,
) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    let summaries_dir = app_data.join("summaries");
    std::fs::create_dir_all(&summaries_dir).map_err(|e| format!("mkdir summaries: {}", e))?;
    let output_file = summaries_dir.join(format!("{}.md", meeting_id));

    // Удаляем старый файл если есть - чтобы polling увидел именно свежий
    // (созданный AI прямо сейчас в ответ на нашу save-команду).
    let _ = std::fs::remove_file(&output_file);

    // Шлём AI команду через bracketed paste + Enter.
    // Bracketed paste нужен для многострочного ввода в claude TUI -
    // иначе \n трактуется как submit и команда отправится по частям.
    let save_command = format!(
        "Запиши текущую финальную версию резюме встречи в файл по пути {} используя tool Write. \
        Содержимое - markdown резюме которое ты только что показал в чате. \
        После записи кратко скажи в чате: СОХРАНЕНО.",
        output_file.to_string_lossy()
    );
    let payload = format!("\x1b[200~{}\x1b[201~\r", save_command);
    state_pty.write(&session_id, payload.as_bytes())?;

    // Polling файла каждые 1 сек, до 60 сек.
    // 60 сек хватает на AI-ответ + write tool call.
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        if let Ok(content) = std::fs::read_to_string(&output_file) {
            if content.trim().len() > 30 {
                return Ok(content);
            }
        }
    }

    Err("AI не записал файл за 60 секунд. Попробуй ещё раз или попроси AI повторить.".to_string())
}

/// Прочитать резюме созданное AI (через tool Write) из summaries/<meeting_id>.md.
/// Возвращает None если файла нет — фронт fallback на парсинг буфера.
#[tauri::command]
pub async fn ai_summary_read_file<R: Runtime>(
    app: tauri::AppHandle<R>,
    meeting_id: String,
) -> Result<Option<String>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    let path = app_data.join("summaries").join(format!("{}.md", meeting_id));
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            if content.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(content))
            }
        }
        Err(_) => Ok(None),
    }
}
