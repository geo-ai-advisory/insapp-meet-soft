pub fn format_timestamp(seconds: f64) -> String {
    let total_seconds = seconds as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let secs = total_seconds % 60;
    format!("{:02}:{:02}:{:02}", hours, minutes, secs)
}

/// Opens macOS System Settings to a specific privacy preference pane
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn open_system_settings(preference_pane: String) -> Result<(), String> {
    use std::process::Command;

    // Construct the URL for System Settings
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{}", preference_pane);

    // Use the 'open' command on macOS to open the URL
    Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open system settings: {}", e))?;

    Ok(())
}

/// Открыть системные настройки доступа к микрофону (кроссплатформенно).
/// Нужно, когда запись идёт, но звука с микрофона нет (после обновления Windows
/// часто сбрасывает доступ к микрофону для классических приложений, а само
/// приложение доступ программно не запрашивает). Ведём пользователя прямо в настройки.
#[tauri::command]
pub async fn open_microphone_settings() -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        // Windows 10/11: Параметры → Конфиденциальность → Микрофон
        Command::new("cmd")
            .args(["/C", "start", "ms-settings:privacy-microphone"])
            .spawn()
            .map_err(|e| format!("Не удалось открыть настройки микрофона: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map_err(|e| format!("Не удалось открыть настройки микрофона: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("xdg-open").arg("settings://privacy").spawn();
    }

    Ok(())
}