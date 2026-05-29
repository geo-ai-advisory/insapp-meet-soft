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

        let mut cmd = CommandBuilder::new(&command);
        for a in &args {
            cmd.arg(a);
        }
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }
        // По умолчанию подключаем PATH (важно чтобы найти claude/codex)
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", path);
        }
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
        for (k, v) in env_extra {
            cmd.env(k, v);
        }

        let mut child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Не удалось запустить '{}': {}", command, e))?;

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
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        if let Err(e) = app_clone.emit(&output_event, chunk) {
                            warn!("emit {} failed: {}", output_event, e);
                            break;
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

        self.sessions
            .lock()
            .map_err(|_| "lock poisoned".to_string())?
            .insert(id.clone(), session);

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
