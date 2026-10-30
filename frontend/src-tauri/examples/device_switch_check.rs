//! Слежение за устройствами (audio::device_watch) на настоящем звуке: запись с микрофона без окна, без
//! базы и без папки записи; «смена устройства» - выбранный микрофон переключается на запасной и обратно
//! (системные настройки звука не трогаем). Слежение должно само пересоздать поток, звук после каждой
//! смены должен идти дальше.
//!
//! Запуск: device_switch_check [запасной микрофон, по умолчанию «Микрофон MacBook Pro»]
use app_lib::audio::device_watch::{read_scene, set_preferred_mic, watch, RestartFuture, Scene, WatchTiming};
use app_lib::audio::{AudioDevice, DeviceType, RecordingManager};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

static MANAGER: Mutex<Option<RecordingManager>> = Mutex::new(None);

fn chunks() -> u64 {
    MANAGER.lock().unwrap().as_ref().map(|m| m.get_state().get_stats().chunks_processed).unwrap_or(0)
}

fn mic_now() -> String {
    MANAGER
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get_state().get_microphone_device())
        .map(|d| d.name.clone())
        .unwrap_or_default()
}

async fn restart(scene: Scene) -> Result<(), String> {
    let mic = scene.mic.map(|d| Arc::new(AudioDevice::new(d.name, DeviceType::Input)));
    tokio::task::spawn_blocking(move || {
        tokio::runtime::Handle::current().block_on(async {
            let mut g = MANAGER.lock().unwrap();
            g.as_mut().unwrap().restart_streams(mic, None).await.map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Сколько кусков звука пришло за `secs` секунд.
async fn flow(secs: u64) -> u64 {
    let a = chunks();
    tokio::time::sleep(Duration::from_secs(secs)).await;
    chunks() - a
}

fn main() {
    let spare = std::env::args().nth(1).unwrap_or_else(|| "Микрофон MacBook Pro".to_string());
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        set_preferred_mic(None);
        let start = read_scene().mic.expect("нет микрофона по умолчанию");
        println!("старт: микрофон по умолчанию {} ({} Гц)", start.name, start.rate);
        let mut manager = RecordingManager::new();
        let mic = Arc::new(AudioDevice::new(start.name.clone(), DeviceType::Input));
        let mut rx = manager.start_recording(Some(mic), None, false).await.expect("запись не началась");
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        *MANAGER.lock().unwrap() = Some(manager);

        let alive = Arc::new(AtomicBool::new(true));
        let a2 = alive.clone();
        let restart_fn = |s: Scene| -> RestartFuture { Box::pin(restart(s)) };
        let watcher = tokio::spawn(watch(read_scene, restart_fn, move || a2.load(Ordering::SeqCst), false, WatchTiming::LIVE));

        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut ok = true;
        let base = flow(3).await;
        println!("1. до смены: микрофон «{}», кусков звука за 3 с: {}", mic_now(), base);
        ok &= base > 0;

        set_preferred_mic(Some(spare.clone()));
        tokio::time::sleep(Duration::from_secs(5)).await;
        let f = flow(3).await;
        let m = mic_now();
        println!("2. выбран «{}»: микрофон записи «{}», кусков за 3 с: {}", spare, m, f);
        ok &= m == spare && f > 0;

        set_preferred_mic(None);
        tokio::time::sleep(Duration::from_secs(5)).await;
        let f = flow(3).await;
        let m = mic_now();
        println!("3. снова по умолчанию: микрофон записи «{}», кусков за 3 с: {}", m, f);
        ok &= m == start.name && f > 0;

        alive.store(false, Ordering::SeqCst);
        let _ = watcher.await;
        let m = MANAGER.lock().unwrap().take();
        if let Some(mut m) = m {
            let _ = m.stop_streams_only().await;
        }
        println!("ИТОГ: {}", if ok { "слежение переключило микрофон оба раза, звук шёл" } else { "ОШИБКА" });
    });
}
