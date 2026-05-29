// Системные уведомления через `alerter` sidecar (https://github.com/vjeantet/alerter).
//
// alerter использует современный UNUserNotificationCenter framework macOS 11+,
// в отличие от terminal-notifier который использует deprecated NSUserNotification
// (не работает на macOS 14+).
//
// alerter binary встроен в bundle Resources при сборке Tauri.

use std::process::Command;
use tauri::{AppHandle, Manager, Runtime};
use tracing::{info, warn};

/// Найти путь к встроенному notifier бинарю в bundle.
/// Notifier - это alerter-binary обёрнутый в Insapp-notifier.app с собственным
/// bundle id `tech.insap.meet.notifier` и Info.plist, чтобы macOS Notification
/// Center зарегистрировал его и показывал уведомления.
fn find_notifier_binary<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        resource_dir.join("resources/Insapp-notifier.app/Contents/MacOS/Insapp-notifier"),
        resource_dir.join("Insapp-notifier.app/Contents/MacOS/Insapp-notifier"),
        resource_dir
            .join("_up_/resources/Insapp-notifier.app/Contents/MacOS/Insapp-notifier"),
    ];
    for c in &candidates {
        if c.exists() {
            return Some(c.clone());
        }
    }
    None
}

/// Показать системное macOS уведомление.
pub fn show<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    subtitle: &str,
    message: &str,
) -> Result<(), String> {
    let binary = match find_notifier_binary(app) {
        Some(p) => p,
        None => {
            warn!("[system_notify] Insapp-notifier binary не найден в bundle");
            return Err("Insapp-notifier sidecar не найден".to_string());
        }
    };

    info!("[system_notify] показываю уведомление: {} / {}", title, message);

    // alerter --message обязательный, остальное опционально
    // --timeout 10 - уведомление само исчезнет через 10 сек
    let result = Command::new(&binary)
        .args([
            "--title", title,
            "--subtitle", subtitle,
            "--message", message,
            "--sound", "Glass",
            "--timeout", "10",
        ])
        .spawn();

    match result {
        Ok(_child) => {
            // НЕ ждём child - alerter в timeout режиме блокирует пока юзер не закроет
            info!("[system_notify] alerter запущен в фоне");
            Ok(())
        }
        Err(e) => {
            warn!("[system_notify] не удалось запустить alerter: {}", e);
            Err(format!("Не удалось запустить notifier: {}", e))
        }
    }
}

/// Tauri-команда для тестового уведомления (из UI-кнопки).
#[tauri::command]
pub async fn system_notify_test<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    show(
        &app,
        "Insapp-meet",
        "Тест уведомлений",
        "Если ты это видишь — всё работает. Дай разрешение если macOS просит.",
    )
    .map(|_| "ok".to_string())
}
