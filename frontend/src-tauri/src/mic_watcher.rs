// Mic Watcher - детекция активации микрофона через CoreAudio.
//
// Через `AudioObjectGetPropertyData(kAudioDevicePropertyDeviceIsRunningSomewhere)`
// проверяем default input device: 1 = какой-то процесс активно использует микрофон,
// 0 = не используется.
//
// Когда меняется с 0→1 - значит юзер только что зашёл во встречу.
// Дополнительно проверяем какие из whitelist apps запущены чтобы определить
// какое именно приложение это (Telemost/Zoom/...).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::time::interval;
use tracing::{info, warn};

const POLL_INTERVAL_SECS: u64 = 2;
const COOLDOWN_SECS: u64 = 300;

pub fn default_whitelist() -> Vec<MeetingApp> {
    vec![
        MeetingApp { bundle_id: "ru.yandex.desktop.telemost".into(), name: "Telemost".into() },
        MeetingApp { bundle_id: "us.zoom.xos".into(), name: "Zoom".into() },
        MeetingApp { bundle_id: "com.microsoft.teams2".into(), name: "Microsoft Teams".into() },
        MeetingApp { bundle_id: "com.microsoft.teams".into(), name: "Microsoft Teams".into() },
        MeetingApp { bundle_id: "com.apple.FaceTime".into(), name: "FaceTime".into() },
        MeetingApp { bundle_id: "com.tdesktop.Telegram".into(), name: "Telegram".into() },
        MeetingApp { bundle_id: "ru.keepcoder.Telegram".into(), name: "Telegram".into() },
        MeetingApp { bundle_id: "desktop.WhatsApp".into(), name: "WhatsApp".into() },
        MeetingApp { bundle_id: "com.discord.Discord".into(), name: "Discord".into() },
        MeetingApp { bundle_id: "com.hnc.Discord".into(), name: "Discord".into() },
        MeetingApp { bundle_id: "com.skype.skype".into(), name: "Skype".into() },
        MeetingApp { bundle_id: "com.linkedin.LinkedIn".into(), name: "LinkedIn".into() },
        MeetingApp { bundle_id: "com.webex.meetingmanager".into(), name: "Webex".into() },
    ]
}

pub fn default_blacklist() -> Vec<String> {
    vec![
        "com.prakashjoshipax.VoiceInk".into(),
        "VoiceInk".into(),
        "tech.insap.meet".into(),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingApp {
    pub bundle_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MicWatcherSettings {
    pub enabled: bool,
    pub whitelist: Vec<MeetingApp>,
    pub blacklist: Vec<String>,
}

impl Default for MicWatcherSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            whitelist: default_whitelist(),
            blacklist: default_blacklist(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MicActivatedEvent {
    pub app_name: String,
    pub bundle_id: String,
}

pub struct MicWatcherState {
    last_shown: Mutex<HashMap<String, Instant>>,
    enabled: Mutex<bool>,
    settings: Mutex<MicWatcherSettings>,
}

impl MicWatcherState {
    pub fn new() -> Self {
        Self {
            last_shown: Mutex::new(HashMap::new()),
            enabled: Mutex::new(true),
            settings: Mutex::new(MicWatcherSettings::default()),
        }
    }

    pub fn set_enabled(&self, on: bool) {
        if let Ok(mut g) = self.enabled.lock() { *g = on; }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.lock().map(|g| *g).unwrap_or(false)
    }

    pub fn snapshot_settings(&self) -> MicWatcherSettings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn update_settings(&self, new_settings: MicWatcherSettings) {
        if let Ok(mut g) = self.settings.lock() { *g = new_settings; }
    }

    pub fn can_show(&self, key: &str) -> bool {
        let mut guard = match self.last_shown.lock() { Ok(g) => g, Err(_) => return false };
        let now = Instant::now();
        if let Some(prev) = guard.get(key) {
            if now.duration_since(*prev) < Duration::from_secs(COOLDOWN_SECS) {
                return false;
            }
        }
        guard.insert(key.to_string(), now);
        true
    }

    pub fn mark_ignored(&self, key: &str) {
        if let Ok(mut g) = self.last_shown.lock() {
            g.insert(key.to_string(), Instant::now());
        }
    }
}

// ============================================================
// CoreAudio - проверка активности микрофона
// ============================================================

/// Проверить активен ли default input device (микрофон).
///
/// `kAudioDevicePropertyDeviceIsRunningSomewhere` возвращает 1 если ЛЮБОЙ процесс
/// в системе активно использует устройство, 0 если нет.
#[cfg(target_os = "macos")]
fn is_microphone_active() -> bool {
    use coreaudio_sys::*;
    use std::mem;

    unsafe {
        // 1. Получаем default input device ID
        let mut device_id: AudioDeviceID = 0;
        let mut size = mem::size_of::<AudioDeviceID>() as u32;
        let prop_default_input = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &prop_default_input,
            0,
            std::ptr::null(),
            &mut size,
            &mut device_id as *mut _ as *mut _,
        );
        if status != 0 || device_id == 0 {
            return false;
        }

        // 2. Спросим у этого устройства - is running somewhere
        let mut is_running: u32 = 0;
        let mut size = mem::size_of::<u32>() as u32;
        let prop_running = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let status = AudioObjectGetPropertyData(
            device_id,
            &prop_running,
            0,
            std::ptr::null(),
            &mut size,
            &mut is_running as *mut _ as *mut _,
        );
        if status != 0 {
            return false;
        }
        is_running != 0
    }
}

#[cfg(not(target_os = "macos"))]
fn is_microphone_active() -> bool {
    false
}

/// Получить bundle id всех запущенных GUI-приложений (для определения какое именно
/// приложение сейчас использует микрофон).
#[cfg(target_os = "macos")]
fn get_running_bundle_ids() -> Vec<String> {
    use std::process::Command;
    let out = match Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to get bundle identifier of every application process whose background only is false"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if !out.status.success() {
        return Vec::new();
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim()
        .split(", ")
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty() && *x != "missing value")
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn get_running_bundle_ids() -> Vec<String> { Vec::new() }

/// Запустить фоновый watcher.
///
/// Логика: ловим переход «микрофон не использовался → начал использоваться».
/// Когда сработал переход 0→1 — смотрим какие из whitelist-приложений запущены
/// и берём первое подходящее (приоритет специализированным video-call apps).
pub fn start_watcher<R: Runtime>(app: AppHandle<R>) {
    info!("Mic watcher: запускаю детектор активации микрофона (CoreAudio)");

    let state = app.state::<Arc<MicWatcherState>>().inner().clone();

    tauri::async_runtime::spawn(async move {
        let mut tick = interval(Duration::from_secs(POLL_INTERVAL_SECS));
        let mut was_active = false;

        loop {
            tick.tick().await;

            if !state.is_enabled() { continue; }

            let is_active = is_microphone_active();

            // Реагируем только на переход 0→1 (микрофон только что включился)
            let transition_to_active = is_active && !was_active;
            was_active = is_active;

            if !transition_to_active { continue; }

            info!("Mic watcher: переход - микрофон активирован, определяю приложение");

            let settings = state.snapshot_settings();
            if !settings.enabled { continue; }

            // Найти какое из whitelist приложений сейчас запущено
            let running = get_running_bundle_ids();
            let matched = settings.whitelist.iter().find(|app| {
                running.iter().any(|r| r.eq_ignore_ascii_case(&app.bundle_id))
                    && !settings.blacklist.iter().any(|b| b.eq_ignore_ascii_case(&app.bundle_id))
            });

            let app_info = match matched {
                Some(a) => a.clone(),
                None => {
                    info!("Mic watcher: микрофон активен, но whitelist-приложений не запущено - пропускаю");
                    continue;
                }
            };

            if !state.can_show(&app_info.bundle_id) {
                info!("Mic watcher: cooldown для {}, пропускаю", app_info.bundle_id);
                continue;
            }

            info!(
                "Mic watcher: микрофон активирован, приложение для встреч = {} ({})",
                app_info.name, app_info.bundle_id
            );

            let payload = MicActivatedEvent {
                app_name: app_info.name.clone(),
                bundle_id: app_info.bundle_id.clone(),
            };

            if let Err(e) = app.emit("mic-meeting-app-detected", &payload) {
                warn!("emit failed: {}", e);
            }

            // Открываем всплывающее окно
            crate::meeting_popup::show(&app, &app_info.name, &app_info.bundle_id);
        }
    });
}
