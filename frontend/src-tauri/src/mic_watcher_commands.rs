// Tauri-команды для UI - управление авто-попапом микрофона.

use std::sync::Arc;
use tauri::{Runtime, State};

use crate::mic_watcher::{MicWatcherSettings, MicWatcherState};

#[tauri::command]
pub async fn mic_watcher_get_settings<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<MicWatcherState>>,
) -> Result<MicWatcherSettings, String> {
    Ok(state.snapshot_settings())
}

#[tauri::command]
pub async fn mic_watcher_save_settings<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<MicWatcherState>>,
    settings: MicWatcherSettings,
) -> Result<(), String> {
    state.set_enabled(settings.enabled);
    state.update_settings(settings);
    Ok(())
}

/// «Игнорировать» в окне-попапе: ПОСТОЯННО добавить приложение в игнор + сохранить
/// на диск (переживает перезапуск). Также ставим кулдаун, чтобы окно сразу не мигало.
#[tauri::command]
pub async fn mic_watcher_mark_ignored<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<MicWatcherState>>,
    bundle_id: String,
    name: Option<String>,
) -> Result<(), String> {
    let nm = name.unwrap_or_default();
    state.add_to_blacklist(&bundle_id, &nm);
    state.mark_ignored(&bundle_id);
    Ok(())
}

/// «Вернуть» приложение из списка игнорируемых (Настройки → Игнорируемые приложения).
#[tauri::command]
pub async fn mic_watcher_unignore<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<MicWatcherState>>,
    bundle_id: String,
) -> Result<(), String> {
    state.remove_from_blacklist(&bundle_id);
    Ok(())
}

#[tauri::command]
pub async fn mic_watcher_set_enabled<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<MicWatcherState>>,
    enabled: bool,
) -> Result<(), String> {
    state.set_enabled(enabled);
    let mut current = state.snapshot_settings();
    current.enabled = enabled;
    state.update_settings(current);
    Ok(())
}
