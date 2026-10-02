#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use log;
use env_logger;
use std::io::Write;

/// Журнал приложения в файл: macOS - ~/Library/Logs/tech.insap.meet/app.log,
/// Windows - %LOCALAPPDATA%\tech.insap.meet\logs\app.log.
/// Раньше журнал шёл только в консоль, а у приложения, открытого из Finder, консоль - /dev/null:
/// разбирать сбои у пользователя было не по чему (Geo 02.10: «проверь логи» - логов не было).
/// Больше 20 МБ на старте - прежний журнал уходит в app.1.log.
fn log_file() -> Option<std::fs::File> {
    #[cfg(target_os = "macos")]
    let dir = dirs::home_dir()?.join("Library/Logs/tech.insap.meet");
    #[cfg(not(target_os = "macos"))]
    let dir = dirs::data_local_dir()?.join("tech.insap.meet").join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("app.log");
    if std::fs::metadata(&path).map(|m| m.len() > 20 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("app.1.log"));
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()
}

/// Запись и в консоль (для запуска из терминала), и в файл.
struct Tee(std::fs::File);

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        self.0.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().flush();
        self.0.flush()
    }
}

fn main() {
    std::env::set_var("RUST_LOG", "info");
    let mut logger = env_logger::Builder::from_default_env();
    logger.format_timestamp_millis();
    if let Some(file) = log_file() {
        logger.target(env_logger::Target::Pipe(Box::new(Tee(file))));
    }
    logger.init();

    // Async logger will be initialized lazily when first needed (after Tauri runtime starts)
    log::info!("Starting application {}...", env!("CARGO_PKG_VERSION"));
    app_lib::run();
}
