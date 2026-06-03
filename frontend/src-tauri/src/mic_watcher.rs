// Mic Watcher - детекция активации микрофона через CoreAudio.
//
// ТОЧНЫЙ режим (macOS 14.2+): per-process API -
//   kAudioHardwarePropertyProcessObjectList -> список аудио-процессов,
//   kAudioProcessPropertyIsRunningInput     -> кто активно пишет ВХОД (микрофон),
//   kAudioProcessPropertyBundleID           -> bundle id конкретного приложения.
// Так мы знаем РЕАЛЬНОЕ приложение, держащее микрофон, без угадывания.
//
// Запасной режим (старые macOS / пустой ответ): device-level
//   kAudioDevicePropertyDeviceIsRunningSomewhere + поиск запущенных whitelist-приложений.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::time::interval;
use tracing::{info, warn};

const POLL_INTERVAL_SECS: u64 = 2;
const COOLDOWN_SECS: u64 = 300;
const SETTINGS_FILENAME: &str = "mic-watcher-settings.json";

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

pub fn default_blacklist() -> Vec<MeetingApp> {
    vec![
        // Только сам Insapp-meet - чтобы не предлагать запись, когда МЫ записываем.
        // VoiceInk и прочие в дефолт НЕ кладём: окно появляется для ЛЮБОГО приложения
        // с микрофоном, а пользователь сам жмёт «Игнорировать» для ненужных.
        MeetingApp { bundle_id: "tech.insap.meet".into(), name: "Insapp-meet".into() },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingApp {
    pub bundle_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MicWatcherSettings {
    pub enabled: bool,
    pub whitelist: Vec<MeetingApp>,
    pub blacklist: Vec<MeetingApp>,
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

// ============================================================
// Персист настроек на диск (рядом с insapp-credentials.json)
// ============================================================

fn settings_path() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("tech.insap.meet").join(SETTINGS_FILENAME))
}

fn load_settings_from_disk() -> MicWatcherSettings {
    let path = match settings_path() {
        Some(p) => p,
        None => return MicWatcherSettings::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(c) => serde_json::from_str::<MicWatcherSettings>(&c).unwrap_or_default(),
        Err(_) => MicWatcherSettings::default(),
    }
}

fn save_settings_to_disk(s: &MicWatcherSettings) {
    if let Some(path) = settings_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(s) {
            if let Err(e) = std::fs::write(&path, json) {
                warn!("mic_watcher: не удалось сохранить настройки: {}", e);
            }
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
        let s = load_settings_from_disk();
        Self {
            last_shown: Mutex::new(HashMap::new()),
            enabled: Mutex::new(s.enabled),
            settings: Mutex::new(s),
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
        if let Ok(mut g) = self.settings.lock() { *g = new_settings.clone(); }
        save_settings_to_disk(&new_settings);
    }

    /// Постоянно игнорировать приложение: добавить в blacklist + сохранить на диск.
    pub fn add_to_blacklist(&self, bundle_id: &str, name: &str) {
        if let Ok(mut g) = self.settings.lock() {
            if !g.blacklist.iter().any(|b| b.bundle_id.eq_ignore_ascii_case(bundle_id)) {
                g.blacklist.push(MeetingApp {
                    bundle_id: bundle_id.to_string(),
                    name: if name.is_empty() { bundle_id.to_string() } else { name.to_string() },
                });
            }
            save_settings_to_disk(&g);
        }
    }

    /// Вернуть приложение из игнора: убрать из blacklist + сохранить.
    pub fn remove_from_blacklist(&self, bundle_id: &str) {
        if let Ok(mut g) = self.settings.lock() {
            g.blacklist.retain(|b| !b.bundle_id.eq_ignore_ascii_case(bundle_id));
            save_settings_to_disk(&g);
        }
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

    /// Временно подавить (кулдаун) - для случая когда юзер закрыл окно крестиком.
    pub fn mark_ignored(&self, key: &str) {
        if let Ok(mut g) = self.last_shown.lock() {
            g.insert(key.to_string(), Instant::now());
        }
    }
}

// ============================================================
// CoreAudio - per-process детекция (точный режим)
// ============================================================

/// Преобразовать CFString в Rust String.
#[cfg(target_os = "macos")]
fn cfstring_to_string(cfref: coreaudio_sys::CFStringRef) -> String {
    use coreaudio_sys::*;
    if cfref.is_null() {
        return String::new();
    }
    unsafe {
        let mut buf = [0i8; 512];
        let ok = CFStringGetCString(cfref, buf.as_mut_ptr(), buf.len() as _, kCFStringEncodingUTF8);
        if ok == 0 {
            return String::new();
        }
        std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned()
    }
}

/// Bundle id всех приложений, которые ПРЯМО СЕЙЧАС держат микрофон (вход).
/// macOS 14.2+. На старых системах вернёт пустой вектор -> сработает fallback.
#[cfg(target_os = "macos")]
fn apps_using_microphone() -> Vec<String> {
    use coreaudio_sys::*;
    use std::mem;

    let mut result: Vec<String> = Vec::new();
    unsafe {
        // 1. Список аудио-процессов
        let prop_list = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut size: u32 = 0;
        let st = AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject,
            &prop_list,
            0,
            std::ptr::null(),
            &mut size,
        );
        if st != 0 || size == 0 {
            return result;
        }
        let n = size as usize / mem::size_of::<AudioObjectID>();
        let mut objs: Vec<AudioObjectID> = vec![0; n];
        let st = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &prop_list,
            0,
            std::ptr::null(),
            &mut size,
            objs.as_mut_ptr() as *mut _,
        );
        if st != 0 {
            return result;
        }

        for obj in objs {
            // 2. Этот процесс активно использует ВХОД (микрофон)?
            let prop_in = AudioObjectPropertyAddress {
                mSelector: kAudioProcessPropertyIsRunningInput,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };
            let mut running: u32 = 0;
            let mut sz = mem::size_of::<u32>() as u32;
            let st = AudioObjectGetPropertyData(
                obj,
                &prop_in,
                0,
                std::ptr::null(),
                &mut sz,
                &mut running as *mut _ as *mut _,
            );
            if st != 0 || running == 0 {
                continue;
            }

            // 3. Bundle id процесса
            let prop_bid = AudioObjectPropertyAddress {
                mSelector: kAudioProcessPropertyBundleID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };
            let mut cfref: CFStringRef = std::ptr::null();
            let mut sz2 = mem::size_of::<CFStringRef>() as u32;
            let st = AudioObjectGetPropertyData(
                obj,
                &prop_bid,
                0,
                std::ptr::null(),
                &mut sz2,
                &mut cfref as *mut _ as *mut _,
            );
            if st != 0 || cfref.is_null() {
                continue;
            }
            let bid = cfstring_to_string(cfref);
            CFRelease(cfref as *const _ as *const ::std::os::raw::c_void);
            if !bid.is_empty() {
                result.push(bid);
            }
        }
    }
    result
}

#[cfg(not(target_os = "macos"))]
fn apps_using_microphone() -> Vec<String> {
    Vec::new()
}

/// Активен ли default input device (любой процесс) - для запасного режима.
#[cfg(target_os = "macos")]
fn is_microphone_active() -> bool {
    use coreaudio_sys::*;
    use std::mem;

    unsafe {
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

/// Запущенные GUI-приложения (bundle id) - для запасного режима.
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

/// Распознать браузер по bundle id (включая helper/GPU-процессы, которые реально
/// держат микрофон при звонке в Google Meet/Zoom-web). Возвращает «канонический»
/// MeetingApp: bundle главного браузера + понятное имя. Браузер считается одним
/// приложением (различить сайт внутри нельзя - ограничение системы, как у Hyprnote).
fn browser_identity(bundle_id: &str) -> Option<MeetingApp> {
    let b = bundle_id.to_ascii_lowercase();
    // (префикс bundle id -> канонический bundle, понятное имя)
    let families: [(&str, &str, &str); 11] = [
        ("company.thebrowser", "company.thebrowser.Browser", "Arc"),
        ("com.google.chrome", "com.google.Chrome", "Google Chrome"),
        ("com.apple.safari", "com.apple.Safari", "Safari"),
        ("com.apple.webkit", "com.apple.Safari", "Safari"),
        ("com.microsoft.edgemac", "com.microsoft.edgemac", "Microsoft Edge"),
        ("org.mozilla.firefox", "org.mozilla.firefox", "Firefox"),
        ("com.brave.browser", "com.brave.Browser", "Brave"),
        ("ru.yandex.desktop.yandex-browser", "ru.yandex.desktop.yandex-browser", "Yandex Browser"),
        ("com.operasoftware.opera", "com.operasoftware.Opera", "Opera"),
        ("com.vivaldi.vivaldi", "com.vivaldi.Vivaldi", "Vivaldi"),
        ("org.chromium.chromium", "org.chromium.Chromium", "Chromium"),
    ];
    for (prefix, main, name) in families {
        if b.starts_with(prefix) {
            return Some(MeetingApp { bundle_id: main.to_string(), name: name.to_string() });
        }
    }
    None
}

/// Приложение для показа окна по ДЕТЕКТИРОВАННОМУ bundle id:
/// браузер (по семейству, в т.ч. helper) -> имя из whitelist -> производное имя.
/// Всегда Some: окно появляется для ЛЮБОГО приложения с микрофоном, ненужные
/// пользователь сам отправляет в игнор кнопкой «Игнорировать».
fn resolve_meeting_app(bundle_id: &str, settings: &MicWatcherSettings) -> Option<MeetingApp> {
    if let Some(b) = browser_identity(bundle_id) {
        return Some(b);
    }
    if let Some(w) = settings
        .whitelist
        .iter()
        .find(|a| a.bundle_id.eq_ignore_ascii_case(bundle_id))
    {
        return Some(w.clone());
    }
    Some(MeetingApp {
        bundle_id: bundle_id.to_string(),
        name: derive_app_name(bundle_id),
    })
}

/// Имя приложения из bundle id: последний компонент
/// (com.prakashjoshipax.VoiceInk -> VoiceInk).
fn derive_app_name(bundle_id: &str) -> String {
    bundle_id
        .rsplit('.')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(bundle_id)
        .to_string()
}

/// Найти подходящее whitelist-приложение по списку bundle id (с учётом blacklist).
fn match_meeting_app(
    settings: &MicWatcherSettings,
    candidate_bundle_ids: &[String],
) -> Option<MeetingApp> {
    settings
        .whitelist
        .iter()
        .find(|app| {
            candidate_bundle_ids.iter().any(|r| r.eq_ignore_ascii_case(&app.bundle_id))
                && !settings.blacklist.iter().any(|b| b.bundle_id.eq_ignore_ascii_case(&app.bundle_id))
        })
        .cloned()
}

/// Запустить фоновый watcher.
///
/// ТОЧНЫЙ режим: на каждом тике берём множество приложений, держащих микрофон.
/// Для НОВОГО (только что начавшего) приложения: если в blacklist - пропускаем;
/// если это митинг-приложение из whitelist - показываем окно с ЕГО именем; иначе
/// (неизвестное приложение, напр. VoiceInk) - молчим.
/// ЗАПАСНОЙ режим: если per-process пуст, но device-level говорит «микрофон включён»,
/// угадываем по запущенным whitelist-приложениям (как раньше).
pub fn start_watcher<R: Runtime>(app: AppHandle<R>) {
    info!("Mic watcher: запускаю детектор активации микрофона (CoreAudio per-process)");

    let state = app.state::<Arc<MicWatcherState>>().inner().clone();

    tauri::async_runtime::spawn(async move {
        let mut tick = interval(Duration::from_secs(POLL_INTERVAL_SECS));
        let mut prev_mic_apps: HashSet<String> = HashSet::new();
        let mut was_active_fallback = false;

        loop {
            tick.tick().await;

            if !state.is_enabled() { continue; }
            let settings = state.snapshot_settings();
            if !settings.enabled { continue; }

            // --- Точный режим: кто реально держит микрофон ---
            let mic_apps = apps_using_microphone();

            if !mic_apps.is_empty() {
                let current: HashSet<String> = mic_apps.iter().cloned().collect();
                // Новые приложения, начавшие использовать микрофон на этом тике
                let new_apps: Vec<String> = current
                    .iter()
                    .filter(|b| !prev_mic_apps.contains(*b))
                    .cloned()
                    .collect();
                prev_mic_apps = current;
                was_active_fallback = true;

                for bid in new_apps {
                    // Приводим к митинг-приложению: браузер (вкл. helper-процессы) ИЛИ whitelist.
                    let app_info = match resolve_meeting_app(&bid, &settings) {
                        Some(a) => a,
                        None => {
                            info!("Mic watcher: {} держит микрофон, но не митинг-приложение - молчу", bid);
                            continue;
                        }
                    };
                    // В игноре (по каноническому bundle) - молчим
                    if settings.blacklist.iter().any(|b| b.bundle_id.eq_ignore_ascii_case(&app_info.bundle_id)) {
                        info!("Mic watcher: {} в игноре, пропускаю", app_info.bundle_id);
                        continue;
                    }
                    if !state.can_show(&app_info.bundle_id) { continue; }

                    info!("Mic watcher: точно определено приложение = {} ({})", app_info.name, app_info.bundle_id);
                    let payload = MicActivatedEvent {
                        app_name: app_info.name.clone(),
                        bundle_id: app_info.bundle_id.clone(),
                    };
                    if let Err(e) = app.emit("mic-meeting-app-detected", &payload) {
                        warn!("emit failed: {}", e);
                    }
                    crate::meeting_popup::show(&app, &app_info.name, &app_info.bundle_id);
                }
                continue;
            }

            // --- Запасной режим (старые macOS / пустой per-process) ---
            prev_mic_apps.clear();
            let is_active = is_microphone_active();
            let transition = is_active && !was_active_fallback;
            was_active_fallback = is_active;
            if !transition { continue; }

            let running = get_running_bundle_ids();
            let app_info = match match_meeting_app(&settings, &running) {
                Some(a) => a,
                None => continue,
            };
            if !state.can_show(&app_info.bundle_id) { continue; }

            info!("Mic watcher (запасной): приложение = {} ({})", app_info.name, app_info.bundle_id);
            let payload = MicActivatedEvent {
                app_name: app_info.name.clone(),
                bundle_id: app_info.bundle_id.clone(),
            };
            if let Err(e) = app.emit("mic-meeting-app-detected", &payload) {
                warn!("emit failed: {}", e);
            }
            crate::meeting_popup::show(&app, &app_info.name, &app_info.bundle_id);
        }
    });
}
