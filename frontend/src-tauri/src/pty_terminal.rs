// PTY-терминал для AI-резюме (Phase 2).
//
// Frontend через xterm.js рендерит терминал, backend через portable-pty
// запускает `claude`/`codex`/custom command как pty-процесс и стримит вывод.
//
// API:
//   pty_spawn(command, args, cwd, cols, rows) -> session_id
//   pty_write(session_id, data)
//   pty_resize(session_id, cols, rows)
//   pty_kill(session_id)
//
// Tauri event: "pty-output-{session_id}" - стримит chunks вывода.
// Tauri event: "pty-exit-{session_id}" - когда процесс завершается.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tracing::{error, info, warn};
use uuid::Uuid;

/// PATH обогащённый стандартными местами установки CLI-инструментов.
///
/// GUI-приложения на macOS, запущенные из Dock/Finder, наследуют урезанный
/// launchd-PATH (/usr/bin:/bin:/usr/sbin:/sbin). Поэтому claude (обычно в
/// ~/.local/bin) и codex (в /opt/homebrew/bin) НЕ находятся при spawn.
///
/// Собираем PATH из трёх источников: текущий PATH процесса + реальный PATH
/// из login-shell пользователя (подхватывает nvm/asdf/кастомные пути у разных
/// членов команды) + хардкод стандартных мест на случай если shell недоступен.
pub fn enriched_path() -> String {
    let mut parts: Vec<String> = Vec::new();

    // 1. Текущий PATH процесса
    if let Ok(p) = std::env::var("PATH") {
        parts.extend(p.split(':').map(|s| s.to_string()));
    }

    // 2. Реальный PATH из login-shell пользователя (с таймаутом, чтобы не зависнуть)
    if let Some(shell_path) = path_from_login_shell() {
        parts.extend(shell_path.split(':').map(|s| s.to_string()));
    }

    // 3. Стандартные места установки CLI (claude, codex, npm-global, bun, cargo)
    if let Ok(home) = std::env::var("HOME") {
        for sub in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
            ".deno/bin",
            ".volta/bin",
        ] {
            parts.push(format!("{}/{}", home, sub));
        }
    }
    for fixed in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        parts.push(fixed.to_string());
    }

    // Dedupe сохраняя порядок (первое вхождение приоритетнее)
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| !p.is_empty() && seen.insert(p.clone()));
    parts.join(":")
}

/// Получает PATH из login-shell пользователя (`$SHELL -lic 'echo $PATH'`).
/// Выполняется в отдельном потоке с таймаутом 3 сек - если shell завис или
/// недоступен, возвращает None и используется хардкод стандартных путей.
fn path_from_login_shell() -> Option<String> {
    // Windows: shell-подход не нужен, там PATH наследуется корректно.
    if cfg!(target_os = "windows") {
        return None;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let result = std::process::Command::new(&shell)
            .args(["-lic", "echo __PATH_START__$PATH__PATH_END__"])
            .output();
        let _ = tx.send(result);
    });

    let output = rx.recv_timeout(std::time::Duration::from_secs(3)).ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Вырезаем PATH между маркерами (interactive shell может напечатать prompt/мусор)
    let start = stdout.find("__PATH_START__")? + "__PATH_START__".len();
    let end = stdout[start..].find("__PATH_END__")? + start;
    let path = stdout[start..end].trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Резолвит имя команды (claude/codex) в абсолютный путь по обогащённому PATH.
/// Если уже абсолютный путь или не нашли - возвращает как есть (pty попробует сам).
pub fn resolve_command(command: &str, path: &str) -> String {
    if std::path::Path::new(command).is_absolute() {
        return command.to_string();
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
    which::which_in(command, Some(path), cwd)
        .map(|pb| pb.to_string_lossy().to_string())
        .unwrap_or_else(|_| command.to_string())
}

pub struct PtySession {
    pub id: String,
    pty_pair: PtyPair,
    writer: Box<dyn Write + Send>,
    child_killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn<R: Runtime>(
        &self,
        app: AppHandle<R>,
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        env_extra: HashMap<String, String>,
    ) -> Result<String, String> {
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Не удалось открыть pty: {}", e))?;

        // GUI-приложение на macOS наследует урезанный launchd-PATH, поэтому
        // claude/codex не находятся. Берём обогащённый PATH и резолвим команду
        // в абсолютный путь ДО спавна - тогда поиск не зависит от PATH pty.
        let enriched = enriched_path();
        let resolved = resolve_command(&command, &enriched);
        info!("pty spawn: '{}' -> '{}'", command, resolved);

        let mut cmd = CommandBuilder::new(&resolved);
        for a in &args {
            cmd.arg(a);
        }
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }
        // Передаём обогащённый PATH в окружение pty (claude может звать node/git и т.п.)
        cmd.env("PATH", &enriched);
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
        for (k, v) in env_extra {
            cmd.env(k, v);
        }

        let mut child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| {
                format!(
                    "Не удалось запустить '{}'. Проверь что инструмент установлен и доступен. Детали: {}",
                    command, e
                )
            })?;

        let child_killer = child.clone_killer();

        let reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Не удалось склонировать reader: {}", e))?;

        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| format!("Не удалось получить writer: {}", e))?;

        let id = format!("pty-{}", Uuid::new_v4());

        // Фоновый поток для чтения output
        let output_event = format!("pty-output-{}", id);
        let exit_event = format!("pty-exit-{}", id);
        let app_clone = app.clone();
        let id_for_thread = id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            // Накопитель незавершённых байтов: pty отдаёт данные кусками по 4096,
            // и многобайтовый UTF-8 символ (кириллица = 2 байта) может разорваться
            // на границе чанка. Эмитим только валидную UTF-8 часть, неполный хвост
            // держим до следующего чтения - иначе резюме на русском бьётся в кашу.
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // Поток закрылся - сбрасываем остаток (если есть)
                        if !pending.is_empty() {
                            let tail = String::from_utf8_lossy(&pending).to_string();
                            let _ = app_clone.emit(&output_event, tail);
                        }
                        break;
                    }
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // Сколько байт с начала pending образуют валидный UTF-8
                        let valid_up_to = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) => e.valid_up_to(),
                        };
                        if valid_up_to > 0 {
                            let chunk = String::from_utf8_lossy(&pending[..valid_up_to]).to_string();
                            if let Err(e) = app_clone.emit(&output_event, chunk) {
                                warn!("emit {} failed: {}", output_event, e);
                                break;
                            }
                            pending.drain(..valid_up_to);
                        }
                        // Защита от разрастания при сплошном мусоре: если хвост
                        // подозрительно большой (>8 байт) - значит это не обрезанный
                        // символ (макс 4 байта), сбрасываем как lossy.
                        if pending.len() > 8 {
                            let chunk = String::from_utf8_lossy(&pending).to_string();
                            let _ = app_clone.emit(&output_event, chunk);
                            pending.clear();
                        }
                    }
                    Err(e) => {
                        warn!("pty {} read error: {}", id_for_thread, e);
                        break;
                    }
                }
            }
            info!("pty {} вывод закончился", id_for_thread);
            let _ = app_clone.emit(&exit_event, ());
        });

        // Отдельный поток чтобы ждать exit статус (иначе zombie)
        std::thread::spawn(move || match child.wait() {
            Ok(status) => info!("pty child exit: {:?}", status),
            Err(e) => error!("pty wait error: {}", e),
        });

        let session = PtySession {
            id: id.clone(),
            pty_pair,
            writer,
            child_killer,
        };

        match self.sessions.lock() {
            Ok(mut sessions) => {
                sessions.insert(id.clone(), session);
            }
            Err(_) => {
                // Mutex отравлён (другой поток паниковал держа lock). Процесс уже
                // запущен - убиваем его, иначе claude останется работать без
                // возможности kill через pty_kill (утечка процессов).
                let mut s = session;
                let _ = s.child_killer.kill();
                error!("pty {}: sessions mutex отравлён, процесс остановлен", id);
                return Err("Внутренняя ошибка: не удалось зарегистрировать сессию. Процесс остановлен, попробуй ещё раз.".to_string());
            }
        }

        info!("pty {} запущен: {} {:?}", id, command, args);
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        let s = sessions
            .get_mut(id)
            .ok_or_else(|| format!("Сессия {} не найдена", id))?;
        s.writer
            .write_all(data)
            .map_err(|e| format!("pty write: {}", e))?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        let s = sessions
            .get(id)
            .ok_or_else(|| format!("Сессия {} не найдена", id))?;
        s.pty_pair
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize: {}", e))?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        if let Some(mut s) = sessions.remove(id) {
            if let Err(e) = s.child_killer.kill() {
                warn!("kill pty {}: {}", id, e);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub env: HashMap<String, String>,
}
