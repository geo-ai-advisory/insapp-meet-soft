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
const DEFAULT_PROMPT: &str = "Ты пишешь ПРОТОКОЛ деловой встречи на русском - такой, по которому можно работать, \
а не пересказ. Читатель не был на встрече и должен за минуту понять: кто был, о чём договорились, что кому делать.\n\
\n\
Транскрипт встречи лежит в файле: {file}\n\
Прочитай его целиком (tool Read) и выведи в чат markdown-протокол.\n\
\n\
СТРУКТУРА (блоки выбирай ПО СОДЕРЖАНИЮ встречи - лишние не выдумывай, нужные добавляй):\n\
\n\
1) ШАПКА - три строки без заголовка:\n\
🗓 <О чём встреча - конкретно, не «Обсуждение вопросов»>\n\
<дата, длительность> · <Имя (компания)> · <Имена участников другой стороны (компания)>\n\
<одна строка: что именно смотрели/делали на встрече>\n\
\n\
2) 🎯 Итог - СРАЗУ вторым блоком, 3-5 пунктов: главные решения и что это значит. \
Не процесс, а результат.\n\
\n\
3) ДАЛЕЕ - смысловые блоки по темам встречи, каждый со своим эмодзи и говорящим заголовком. \
Примеры блоков (бери подходящие, придумывай свои по теме): \
✏️ Правки/задачи по продукту (нумерованный список с подпунктами и деталями), \
🪪 / 💳 Уточнить у <сторона> (открытые вопросы к смежникам, в конце строка «→ Флоу: <что из этого следует>»), \
📦 Пострелиз / бэклог (что осознанно вынесли за рамки), \
🔁 Риски и спорные места (позиция сторон + о чём договорились), \
🛟 Поддержка, ⏱ Сроки и SLA.\n\
\n\
4) ⏸ Запарковано - нумерованный список того, что отложили, и почему/чего ждём.\n\
\n\
5) ✅ Действия - РАЗБИТО ПО СТОРОНАМ (по компаниям/командам), с именами исполнителей:\n\
<Сторона 1>:\n\
• <кто>: <что сделать> <срок если назван>\n\
<Сторона 2>:\n\
• ...\n\
\n\
6) 📅 Сроки - ключевые даты, если звучали.\n\
\n\
ПРАВИЛА:\n\
- Конкретика вместо общих слов: имена, цифры, названия систем, сроки. \
Если в транскрипте есть подписи участников («Вы», «Собеседник 1», имена) - используй их, чтобы понять, кто что предложил.\n\
- Каждый пункт - самостоятельная мысль, по которой можно действовать. Не пиши «обсудили X» - пиши, ЧТО решили по X.\n\
- Стрелка → для следствий и выводов.\n\
- Живой деловой язык, без канцелярита и воды. Не пересказывай реплики подряд.\n\
- Транскрипт распознан автоматически: имена и термины могут быть искажены - восстанавливай по смыслу \
(например «пишка/фишка» → «API»), но НЕ выдумывай фактов, которых не было.\n\
- Если чего-то в встрече не было (например SLA) - просто не включай такой блок.\n\
\n\
ВАЖНО: не добавляй заголовок типа \"# Резюме: ...\" в начало - название встречи уже отображается в карточке. \
Начни сразу с шапки 🗓.\n\
\n\
Пиши по-русски, по-деловому, плотно - без вводных фраз и воды. Просто markdown в чат.\n\
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

    // Иначе ищем в обогащённом PATH (GUI-приложение наследует урезанный
    // launchd-PATH, в котором нет ~/.local/bin и /opt/homebrew/bin).
    let enriched = crate::pty_terminal::enriched_path();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
    if let Ok(path) = which::which_in(&command, Some(&enriched), cwd) {
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
    // Защита от path traversal: meeting_id идёт в имена временного файла и файла резюме.
    if meeting_id.is_empty()
        || !meeting_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Некорректный идентификатор встречи".to_string());
    }
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

    // Изолированный cwd для pty: папка данных приложения (app_data_dir =
    // <dirs::data_dir()>/tech.insap.meet), а НЕ домашняя/"/". Без явного cwd
    // shell+claude стартуют в cwd GUI-процесса (HOME или "/") и обращаются к
    // защищённым папкам (~/Desktop, ~/Documents, ~/Downloads, ~/Pictures), из-за
    // чего macOS сыпет TCC-запросами доступа. Для AI-резюме нужен только temp-файл
    // транскрипта, поэтому стартуем процесс в безопасной app-папке.
    // app_data уже существует (выше create_dir_all для подпапок temp/summaries).
    std::fs::create_dir_all(&app_data).map_err(|e| format!("mkdir app_data: {}", e))?;
    let pty_cwd = Some(app_data.to_string_lossy().to_string());

    let session_id = state_pty.spawn(
        app.clone(),
        cmd.clone(),
        args.clone(),
        pty_cwd,
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
            // Раздельная отправка (как в ai_summary_request_save): вставка,
            // пауза, ОТДЕЛЬНЫЙ Enter. Склеенный `\r` после \x1b[201~ TUI
            // claude/codex отправляет НЕ всегда (~30% промахов, проверено
            // pty-репро) - тогда резюме не начинало генерироваться.
            let paste = format!("\x1b[200~{}\x1b[201~", full_prompt);
            let _ = pty_manager.write(&session_id_clone, paste.as_bytes());
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let _ = pty_manager.write(&session_id_clone, b"\r");
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
    // Убираем управляющие символы из названия встречи (берётся из БД): символ
    // \x1b мог сломать bracketed-paste и подсунуть команды в claude TUI.
    let safe_title: String = title
        .chars()
        .map(|c| if (c as u32) < 0x20 { ' ' } else { c })
        .collect();
    let prompt = settings
        .prompt_template
        .replace("{title}", &safe_title)
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
    // Защита от path traversal: meeting_id идёт в имя файла. Допускаем только
    // безопасные символы (буквы/цифры/-/_), иначе "../.." увёл бы запись за пределы папки.
    if meeting_id.is_empty()
        || !meeting_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Некорректный идентификатор встречи".to_string());
    }
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
    // ВАЖНО (баг «срабатывало со второго раза», проверено pty-репродукцией):
    // Enter нельзя склеивать со вставкой. Если слать `\x1b[200~..\x1b[201~\r`
    // одним куском, TUI claude/codex ~30% случаев НЕ трактует `\r` как submit -
    // текст повисает в поле, AI его не получает, ждём таймаут зря.
    // Правильно: (1) вставить текст, (2) дать TUI обработать, (3) ОТДЕЛЬНЫМ
    // нажатием Enter отправить. Этот паттерн в репро = 100% отправок.
    let paste = format!("\x1b[200~{}\x1b[201~", save_command);
    state_pty.write(&session_id, paste.as_bytes())?;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    state_pty.write(&session_id, b"\r")?;

    // Polling файла каждую 1 сек. При корректной отправке AI отвечает за секунды
    // и цикл возвращается СРАЗУ как файл появился (мгновенно при норме).
    // Страховка: если файла нет за ~8 сек (крайне редкий промах Enter в TUI) -
    // ОДИН РАЗ досылаем одиночный Enter. БЕЗ повторной вставки -> текст промпта
    // не задваивается. Безопасно: лишний Enter во время генерации - no-op в claude.
    // 120 сек - запас на медленную генерацию длинной встречи.
    let mut nudged = false;
    for i in 0..120 {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        if let Ok(content) = std::fs::read_to_string(&output_file) {
            if content.trim().len() > 30 {
                return Ok(content);
            }
        }
        if !nudged && i >= 8 {
            let _ = state_pty.write(&session_id, b"\r");
            nudged = true;
        }
    }

    Err("AI не записал файл за 2 минуты. Попробуй ещё раз или попроси AI повторить.".to_string())
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

// ============================================================
// МАССОВОЕ СОЗДАНИЕ РЕЗЮМЕ
// ============================================================
//
// Кнопка «Резюме для всех» на главной. В отличие от одиночного режима
// (интерактивный терминал), здесь CLI запускается НЕИНТЕРАКТИВНО и отдаёт
// готовый markdown в stdout - иначе на каждую встречу открывался бы терминал.
//
// Поддерживаются оба инструмента, как настроено у пользователя:
//   claude -> claude --print <промпт>
//   codex  -> codex exec <промпт>
// Встречи обрабатываются ПО ОЧЕРЕДИ: параллельный запуск упёрся бы в лимиты
// подписки и грел бы машину.

/// Идёт ли сейчас массовое создание резюме + флаг остановки.
/// Нужны, чтобы окно показывало реальный ход работы и умело прерывать очередь.
static BATCH_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static BATCH_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Состояние пакетной генерации резюме - живёт в бэкенде, а не в окне.
///
/// Зачем: окно с прогрессом можно свернуть и открыть снова, при этом React-компонент
/// пересоздаётся и всё, что он помнил, теряется - полоса откатывалась на 0%, список
/// встреч показывался как «ещё не начатые», плавный рост начинался заново. Здесь
/// хранится правда о ходе работы, и окно при открытии просто её забирает.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct BatchState {
    pub done: usize,
    pub total: usize,
    pub failed: usize,
    /// Какая встреча обрабатывается прямо сейчас.
    pub current_id: Option<String>,
    pub current_title: Option<String>,
    /// Когда взялись за текущую встречу (unix-время, мс) - от него окно
    /// считает «идёт N секунд» и плавный рост полосы.
    pub current_started_ms: Option<u64>,
    /// Состояние каждой встречи очереди: id -> "wait" | "running" | "done" | "error".
    pub items: Vec<BatchItem>,
    pub cancelled: bool,
    pub finished: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchItem {
    pub id: String,
    pub title: String,
    pub state: String,
    pub error: Option<String>,
}

static BATCH_STATE: std::sync::Mutex<Option<BatchState>> = std::sync::Mutex::new(None);

/// Процесс, который прямо сейчас делает резюме.
///
/// Нужен, чтобы «Остановить» срабатывало сразу. Раньше отмена лишь поднимала
/// флаг, а цикл смотрел на него только ПЕРЕД следующей встречей - на часовой
/// записи это означало ждать несколько минут, и кнопка выглядела мёртвой.
static CURRENT_CHILD_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn batch_state_set(f: impl FnOnce(&mut BatchState)) {
    if let Ok(mut guard) = BATCH_STATE.lock() {
        if let Some(st) = guard.as_mut() {
            f(st);
        }
    }
}

/// Текущий ход пакетной генерации - окно запрашивает при открытии,
/// чтобы показать реальное состояние, а не начинать с нуля.
#[tauri::command]
pub fn ai_summary_batch_status() -> Option<BatchState> {
    BATCH_STATE.lock().ok().and_then(|g| g.clone())
}


/// Остановить массовое создание резюме. Текущая встреча дорабатывается,
/// следующие не запускаются.
#[tauri::command]
pub fn ai_summary_cancel_batch() {
    BATCH_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);

    // Снимаем процесс, который обрабатывает встречу прямо сейчас - иначе
    // остановка ждала бы окончания текущей встречи (это минуты).
    let pid = CURRENT_CHILD_PID.swap(0, std::sync::atomic::Ordering::Relaxed);
    if pid > 0 {
        #[cfg(unix)]
        { let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).output(); }
        #[cfg(windows)]
        { let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output(); }
        log::info!("[bulk-summary] остановка: снял процесс {}", pid);
    }
    log::info!("[bulk-summary] запрошена остановка");
}

/// Идёт ли сейчас массовая обработка (чтобы окно не запускало вторую).
#[tauri::command]
pub fn ai_summary_batch_running() -> bool {
    BATCH_RUNNING.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchProgress {
    pub done: usize,
    pub total: usize,
    pub meeting_id: String,
    pub title: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Собрать транскрипт встречи в markdown-файл и вернуть путь + название.
async fn prepare_transcript_file<R: Runtime>(
    app: &tauri::AppHandle<R>,
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<(PathBuf, String), String> {
    let rows: Vec<(String, String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT transcript, timestamp, audio_start_time, audio_end_time
         FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time ASC NULLS LAST, timestamp ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Не прочитать транскрипт: {}", e))?;

    if rows.is_empty() {
        return Err("Транскрипт пуст".to_string());
    }

    let title: String = sqlx::query_as::<_, (String,)>("SELECT title FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|(t,)| t)
        .unwrap_or_else(|| "Встреча".to_string());

    // Имена участников, если пользователь их задавал - чтобы резюме писало
    // «Иван», а не «Собеседник 1».
    let names: std::collections::HashMap<String, String> =
        crate::database::repositories::transcript::TranscriptsRepository::get_speaker_names(pool, meeting_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect();
    let speakers: Vec<(String, Option<String>)> = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT transcript, speaker FROM transcripts WHERE meeting_id = ?
         ORDER BY audio_start_time ASC NULLS LAST, timestamp ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    let mut buf = format!("# {}\n\n", title);
    for (i, (text, ts, start, _end)) in rows.iter().enumerate() {
        let stamp = start
            .map(|s| {
                let t = s as u64;
                format!("{:02}:{:02}", t / 60, t % 60)
            })
            .unwrap_or_else(|| ts.clone());
        let who = speakers
            .get(i)
            .and_then(|(_, sp)| sp.as_deref())
            .and_then(|k| crate::insapp_server::speaker_display_name(k, &names));
        match who {
            Some(name) => buf.push_str(&format!("**[{}]** **{}:** {}\n\n", stamp, name, text.trim())),
            None => buf.push_str(&format!("**[{}]** {}\n\n", stamp, text.trim())),
        }
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    let temp_dir = app_data.join("ai-summary-temp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("mkdir: {}", e))?;
    let file = temp_dir.join(format!("{}-batch.md", meeting_id));
    std::fs::write(&file, buf).map_err(|e| format!("write: {}", e))?;
    Ok((file, title))
}

/// Запустить CLI неинтерактивно и получить markdown резюме из stdout.
async fn run_cli_once(
    settings: &AiSummarySettings,
    transcript_path: &PathBuf,
    title: &str,
) -> Result<String, String> {
    let prompt = settings
        .prompt_template
        .replace("{title}", title)
        .replace("{file}", &transcript_path.to_string_lossy())
        .replace("{output}", "");
    let dir = transcript_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let (cmd, args): (String, Vec<String>) = match settings.provider.as_str() {
        // claude: --print отдаёт ответ в stdout вместо интерактивного чата.
        //
        // --setting-sources=project,local ОБЯЗАТЕЛЕН: личные настройки
        // пользователя (~/.claude/settings.json) могут содержать правила,
        // которые новые версии CLI считают некорректными - тогда claude падает
        // ещё до работы, и резюме не создаётся ни для одной встречи.
        // Подписки это не касается: авторизация хранится отдельно от настроек.
        "claude" => (
            settings.command.clone(),
            vec![
                "--print".to_string(),
                "--setting-sources".to_string(),
                "project,local".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--add-dir".to_string(),
                dir,
                "--allowedTools".to_string(),
                "Read".to_string(),
            ],
        ),
        // codex: exec - неинтерактивный режим
        "codex" => (settings.command.clone(), vec!["exec".to_string()]),
        _ => (settings.command.clone(), settings.args.clone()),
    };

    // Промпт передаём ЧЕРЕЗ ВХОДНОЙ ПОТОК, а не аргументом: он многострочный,
    // и как аргумент обрезался - CLI отвечал «нет входных данных».
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(&cmd)
        .args(&args)
        .env("PATH", crate::pty_terminal::enriched_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("не запустить {}: {}", cmd, e))?;

    // Запоминаем процесс - чтобы кнопка «Остановить» могла снять его сразу.
    if let Some(pid) = child.id() {
        CURRENT_CHILD_PID.store(pid, std::sync::atomic::Ordering::Relaxed);
    }

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await; // закрываем поток - иначе CLI ждёт продолжения
    }

    // Ограничение по времени на ОДНУ встречу.
    //
    // Без него зависший процесс держит всю очередь бесконечно: пользователь
    // видит крутилку и не понимает, идёт работа или всё умерло. 12 минут - с
    // большим запасом даже для длинной встречи (обычная укладывается в 1-3).
    // По истечении срока процесс снимаем и отдаём внятную ошибку - встречу
    // можно повторить кнопкой «Повторить».
    let out = match tokio::time::timeout(
        std::time::Duration::from_secs(12 * 60),
        child.wait_with_output(),
    )
    .await
    {
        Ok(res) => {
            CURRENT_CHILD_PID.store(0, std::sync::atomic::Ordering::Relaxed);
            res.map_err(|e| format!("ошибка выполнения {}: {}", cmd, e))?
        }
        Err(_) => {
            CURRENT_CHILD_PID.store(0, std::sync::atomic::Ordering::Relaxed);
            return Err("обработка заняла больше 12 минут и была остановлена".to_string());
        }
    };

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{} вернул ошибку: {}", cmd, err.chars().take(200).collect::<String>()));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err("пустой ответ модели".to_string());
    }
    Ok(text)
}

/// Создать резюме для списка встреч по очереди.
/// Прогресс шлётся событием "bulk-summary-progress", финал - "bulk-summary-done".
#[tauri::command]
pub async fn ai_summary_run_batch<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    meeting_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    if meeting_ids.is_empty() {
        return Err("Не выбрано ни одной встречи".to_string());
    }
    let pool = state.db_manager.pool().clone();
    let settings = load_ai_settings(&pool).await;

    // Проверяем, что инструмент вообще установлен - иначе бессмысленно
    // гонять цикл и сыпать одинаковыми ошибками.
    if which::which_in(&settings.command, Some(crate::pty_terminal::enriched_path()), std::env::current_dir().ok().unwrap_or_default()).is_err()
        && !std::path::Path::new(&settings.command).exists()
    {
        return Err(format!(
            "Не найден инструмент «{}». Проверь настройки AI-резюме.",
            settings.command
        ));
    }

    let total = meeting_ids.len();
    let app_bg = app.clone();
    BATCH_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    BATCH_RUNNING.store(true, std::sync::atomic::Ordering::Relaxed);

    // Готовим состояние очереди заранее - чтобы окно, открытое посреди работы,
    // сразу показало полный список встреч, а не пустоту.
    {
        let mut items = Vec::with_capacity(meeting_ids.len());
        for id in &meeting_ids {
            let title: String = sqlx::query_as::<_, (String,)>("SELECT title FROM meetings WHERE id = ?")
                .bind(id)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                .map(|(t,)| t)
                .unwrap_or_default();
            items.push(BatchItem { id: id.clone(), title, state: "wait".to_string(), error: None });
        }
        if let Ok(mut g) = BATCH_STATE.lock() {
            *g = Some(BatchState { total, items, ..Default::default() });
        }
    }

    tauri::async_runtime::spawn(async move {
        let mut done = 0usize;
        let mut failed = 0usize;
        for id in meeting_ids {
            if BATCH_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
                log::info!("[bulk-summary] остановлено пользователем на {} из {}", done, total);
                break;
            }
            // Сообщаем, за какую встречу взялись - окно показывает её как «идёт».
            let started_title: String =
                sqlx::query_as::<_, (String,)>("SELECT title FROM meetings WHERE id = ?")
                    .bind(&id)
                    .fetch_optional(&pool)
                    .await
                    .ok()
                    .flatten()
                    .map(|(t,)| t)
                    .unwrap_or_default();
            // Фиксируем в состоянии, за какую встречу взялись и когда - от этого
            // окно считает «идёт N секунд» и плавный рост полосы даже после
            // сворачивания и повторного открытия.
            {
                let id_c = id.clone();
                let title_c = started_title.clone();
                batch_state_set(move |st| {
                    st.current_id = Some(id_c.clone());
                    st.current_title = Some(title_c);
                    st.current_started_ms = Some(now_ms());
                    if let Some(item) = st.items.iter_mut().find(|i| i.id == id_c) {
                        item.state = "running".to_string();
                    }
                });
            }

            let _ = app_bg.emit(
                "bulk-summary-started",
                serde_json::json!({ "meeting_id": id, "title": started_title, "done": done, "total": total }),
            );

            let (ok, title, error) = match prepare_transcript_file(&app_bg, &pool, &id).await {
                Ok((file, title)) => match run_cli_once(&settings, &file, &title).await {
                    Ok(markdown) => {
                        let saved = save_summary_markdown(&app_bg, &pool, &id, &markdown).await;
                        let _ = std::fs::remove_file(&file);
                        match saved {
                            Ok(()) => (true, title, None),
                            Err(e) => (false, title, Some(e)),
                        }
                    }
                    Err(e) => {
                        let _ = std::fs::remove_file(&file);
                        (false, title, Some(e))
                    }
                },
                Err(e) => (false, String::new(), Some(e)),
            };

            done += 1;
            if !ok {
                failed += 1;
                log::warn!("[bulk-summary] {} - ошибка: {:?}", id, error);
            }
            {
                let id_c = id.clone();
                let err_c = error.clone();
                batch_state_set(move |st| {
                    st.done = done;
                    st.failed = failed;
                    st.current_id = None;
                    st.current_title = None;
                    st.current_started_ms = None;
                    if let Some(item) = st.items.iter_mut().find(|i| i.id == id_c) {
                        item.state = if ok { "done".to_string() } else { "error".to_string() };
                        item.error = err_c;
                    }
                });
            }

            let _ = app_bg.emit(
                "bulk-summary-progress",
                BatchProgress { done, total, meeting_id: id.clone(), title, ok, error },
            );
        }
        BATCH_RUNNING.store(false, std::sync::atomic::Ordering::Relaxed);
        let cancelled = BATCH_CANCEL.load(std::sync::atomic::Ordering::Relaxed);
        batch_state_set(move |st| {
            st.finished = true;
            st.cancelled = cancelled;
            st.current_id = None;
            st.current_title = None;
            st.current_started_ms = None;
        });
        let _ = app_bg.emit(
            "bulk-summary-done",
            serde_json::json!({ "total": total, "done": done, "failed": failed, "cancelled": cancelled }),
        );
        log::info!("[bulk-summary] готово: {} из {}", total - failed, total);
    });

    Ok(serde_json::json!({ "started": total }))
}

/// Записать готовое резюме встречи в базу (пакетный режим).
/// Тот же формат, что и при ручном сохранении: summary_processes + result-json.
async fn save_summary_markdown<R: Runtime>(
    app: &tauri::AppHandle<R>,
    pool: &SqlitePool,
    meeting_id: &str,
    markdown: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let result_json = serde_json::json!({
        "markdown": markdown,
        "format": "markdown",
        "source": "ai_batch",
        "sync_status": "pending",
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
    .bind(meeting_id)
    .bind(&now)
    .bind(&now)
    .bind(&result_json)
    .execute(pool)
    .await
    .map_err(|e| format!("не сохранить резюме: {}", e))?;

    // ОТПРАВКА РЕЗЮМЕ НА СЕРВЕР.
    //
    // Резюме - отдельная сущность (kind = "summary"), а не часть транскрипта:
    // раньше здесь вызывалась выгрузка встречи, которая шлёт только расшифровку,
    // поэтому по ссылке «Поделиться» резюме не появлялось.
    // Уважаем «только локально»: помеченные встречи не отправляем.
    let locally_only = crate::database::repositories::meeting::MeetingsRepository::get_cloud_opt_out(pool, meeting_id)
        .await
        .unwrap_or(false);

    if !locally_only {
        let settings = crate::insapp_server::load_settings(pool).await;
        let api_key = crate::insapp_server::get_api_key();
        let title: String = sqlx::query_as::<_, (String,)>("SELECT title FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .map(|(t,)| t)
            .unwrap_or_else(|| "Встреча".to_string());

        let st = crate::insapp_server_commands::sync_summary_to_server(
            pool, meeting_id, &title, &settings, &api_key,
        )
        .await;
        log::info!("[bulk-summary] отправка резюме {}: {}", meeting_id, st);
    }

    let _ = app.emit("summary-updated", serde_json::json!({ "meeting_id": meeting_id }));
    Ok(())
}
