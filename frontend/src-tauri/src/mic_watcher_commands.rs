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

#[tauri::command]
pub async fn mic_watcher_mark_ignored<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, Arc<MicWatcherState>>,
    bundle_id: String,
) -> Result<(), String> {
    state.mark_ignored(&bundle_id);
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
