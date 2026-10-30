//! Смена наушников и колонок во время записи - без швов.
//!
//! Geo 30.10: на встрече AirPods на минуту отключились и вернулись, а приложение продолжало слушать
//! старые потоки звука: с этой минуты микрофон не распознавался совсем, собеседники - урывками и с
//! выдуманными английскими «Thank you», пока он сам не выбрал микрофон заново. Поток звука привязан к
//! устройству, каким оно было при старте; вернувшиеся по Bluetooth наушники для системы - уже другое
//! устройство, а пока их нет, звук идёт через встроенные микрофон и динамики с другой частотой.
//!
//! Раз в секунду сверяем обстановку: нужный микрофон (выбранный пользователем, если он подключён,
//! иначе микрофон по умолчанию) и вывод по умолчанию (через него слышно собеседников) - имя, номер
//! устройства в системе и частоту. Обстановка сменилась и держится - пересоздаём потоки звука, как при
//! ручной смене микрофона, запись не прерывается (цикл - watch, запуск - recording_commands::spawn_device_watch).
//! Наушники пропали - пишем со встроенных, вернулись - снова с наушников.

use log::{info, warn};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Устройство, каким его видит система сейчас.
#[derive(Clone, Debug, PartialEq)]
pub struct Dev {
    pub name: String,
    /// Номер устройства в системе (macOS): у вернувшихся Bluetooth-наушников он новый при том же имени.
    pub id: u32,
    pub rate: u32,
}

/// Обстановка: нужный микрофон и вывод по умолчанию.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Scene {
    pub mic: Option<Dev>,
    pub output: Option<Dev>,
}

/// Микрофон, выбранный пользователем для этой записи (None - микрофон по умолчанию).
static PREFERRED_MIC: Mutex<Option<String>> = Mutex::new(None);

/// Потоки только что пересозданы в обход слежения (ручная смена микрофона) - обстановку надо взять заново,
/// иначе слежение увидит «смену» и пересоздаст их второй раз.
static RESTARTED_ELSEWHERE: AtomicBool = AtomicBool::new(false);

pub fn mark_restarted() {
    RESTARTED_ELSEWHERE.store(true, Ordering::SeqCst);
}

pub fn take_restarted() -> bool {
    RESTARTED_ELSEWHERE.swap(false, Ordering::SeqCst)
}

/// Имена из настроек и окна записи бывают с пометкой «(input)» - храним чистое имя устройства.
pub fn set_preferred_mic(name: Option<String>) {
    let clean = name
        .map(|n| {
            let t = n.trim();
            let t = if t.to_lowercase().ends_with("(input)") { &t[..t.len() - "(input)".len()] } else { t };
            t.trim().to_string()
        })
        .filter(|n| !n.is_empty());
    if let Ok(mut p) = PREFERRED_MIC.lock() {
        *p = clean;
    }
}

fn preferred_mic() -> Option<String> {
    PREFERRED_MIC.lock().ok().and_then(|p| p.clone())
}

/// Обстановка сейчас (опрос системы занимает миллисекунды - вызывать вне async).
pub fn read_scene() -> Scene {
    platform::read(preferred_mic().as_deref())
}

/// Пересоздать ли потоки: обстановка отличается от той, на которой они созданы.
/// Пропавшее устройство (None) - не повод: ждём, пока система назначит замену.
/// `with_system` - записывается ли звук собеседников (без него вывод не важен).
pub fn needs_restart(baseline: &Scene, now: &Scene, with_system: bool) -> bool {
    let mic = now.mic.is_some() && now.mic != baseline.mic;
    let output = with_system && now.output.is_some() && now.output != baseline.output;
    mic || output
}

/// Темп слежения.
#[derive(Clone, Copy)]
pub struct WatchTiming {
    /// Как часто сверять обстановку; смена должна продержаться две проверки подряд
    /// (Bluetooth переключается в несколько шагов).
    pub tick: Duration,
    /// Сколько ждать после пересоздания, прежде чем взять новую обстановку: открытый микрофон
    /// переводит Bluetooth-наушники в режим гарнитуры (другая частота вывода).
    pub settle: Duration,
    /// Не больше `max_restarts` пересозданий за `window`: если устройство «моргает» без остановки,
    /// звук не дёргаем.
    pub window: Duration,
    pub max_restarts: usize,
}

impl WatchTiming {
    pub const LIVE: Self = Self {
        tick: Duration::from_secs(1),
        settle: Duration::from_millis(1500),
        window: Duration::from_secs(60),
        max_restarts: 6,
    };
}

pub type RestartFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

/// Цикл слежения. `read` - обстановка сейчас, `restart` - пересоздать потоки на этой обстановке,
/// `alive` - идёт ли ещё эта запись. Части подменяемые - так цикл проверяют тесты.
pub async fn watch<R, S, A>(read: R, mut restart: S, alive: A, with_system: bool, timing: WatchTiming)
where
    R: Fn() -> Scene,
    S: FnMut(Scene) -> RestartFuture,
    A: Fn() -> bool,
{
    let mut baseline = read();
    info!("🎧 Слежение за устройствами: микрофон {}, вывод {}", describe(&baseline.mic), describe(&baseline.output));
    let mut pending: Option<Scene> = None;
    let mut restarts: Vec<tokio::time::Instant> = Vec::new();
    loop {
        tokio::time::sleep(timing.tick).await;
        if !alive() {
            break;
        }
        let now = read();
        if take_restarted() {
            // Микрофон сменили руками - потоки уже новые, это и есть новая обстановка.
            baseline = now;
            pending = None;
            continue;
        }
        if !needs_restart(&baseline, &now, with_system) {
            pending = None;
            continue;
        }
        if pending.as_ref() != Some(&now) {
            pending = Some(now);
            continue;
        }
        pending = None;
        restarts.retain(|t| t.elapsed() < timing.window);
        if restarts.len() >= timing.max_restarts {
            continue;
        }
        restarts.push(tokio::time::Instant::now());
        info!(
            "🎧 Устройства сменились: микрофон {} -> {}, вывод {} -> {} - пересоздаю потоки звука",
            describe(&baseline.mic), describe(&now.mic), describe(&baseline.output), describe(&now.output)
        );
        match restart(now).await {
            Ok(()) => {
                info!("✅ Потоки звука пересозданы - запись продолжается");
                tokio::time::sleep(timing.settle).await;
                baseline = read();
            }
            Err(e) => warn!("⚠️ Потоки звука не пересоздались ({}) - повторю на следующей проверке", e),
        }
    }
}

/// Кратко для журнала: «AirPods Pro (24000 Гц, №91)».
pub fn describe(d: &Option<Dev>) -> String {
    match d {
        Some(d) => format!("{} ({} Гц, №{})", d.name, d.rate, d.id),
        None => "нет".to_string(),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Dev, Scene};
    use cidre::core_audio as ca;

    fn dev(d: &ca::Device) -> Option<Dev> {
        Some(Dev {
            name: d.name().ok()?.to_string(),
            id: d.0 .0,
            rate: d.nominal_sample_rate().ok()? as u32,
        })
    }

    pub fn read(preferred: Option<&str>) -> Scene {
        let chosen = preferred.and_then(|p| {
            ca::System::devices()
                .ok()?
                .into_iter()
                .find(|d| d.name().map(|n| n.to_string() == p).unwrap_or(false))
        });
        let mic = chosen.or_else(|| ca::System::default_input_device().ok());
        Scene {
            mic: mic.as_ref().and_then(dev),
            output: ca::System::default_output_device().ok().as_ref().and_then(dev),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{Dev, Scene};
    use cpal::traits::{DeviceTrait, HostTrait};

    // Номера устройства cpal не даёт - на Windows сверяем имя и частоту.
    fn dev(d: &cpal::Device, input: bool) -> Option<Dev> {
        let cfg = if input { d.default_input_config().ok()? } else { d.default_output_config().ok()? };
        Some(Dev { name: d.name().ok()?, id: 0, rate: cfg.sample_rate().0 })
    }

    pub fn read(preferred: Option<&str>) -> Scene {
        let host = cpal::default_host();
        let chosen = preferred.and_then(|p| {
            host.input_devices().ok()?.find(|d| d.name().map(|n| n == p).unwrap_or(false))
        });
        let mic = chosen.or_else(|| host.default_input_device());
        Scene {
            mic: mic.as_ref().and_then(|d| dev(d, true)),
            output: host.default_output_device().as_ref().and_then(|d| dev(d, false)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(name: &str, id: u32, rate: u32) -> Option<Dev> {
        Some(Dev { name: name.into(), id, rate })
    }

    fn scene(mic: Option<Dev>, output: Option<Dev>) -> Scene {
        Scene { mic, output }
    }

    #[test]
    fn same_scene_no_restart() {
        let s = scene(d("AirPods", 91, 24000), d("AirPods", 91, 24000));
        assert!(!needs_restart(&s, &s.clone(), true));
    }

    #[test]
    fn headphones_gone_switch_to_builtin() {
        // 30.10: AirPods пропали - система отдала звук встроенным микрофону и динамикам.
        let was = scene(d("AirPods", 91, 24000), d("AirPods", 91, 24000));
        let now = scene(d("Микрофон MacBook Pro", 70, 48000), d("Динамики MacBook Pro", 77, 48000));
        assert!(needs_restart(&was, &now, true));
    }

    #[test]
    fn headphones_back_same_name_new_device() {
        // Вернулись с тем же именем и частотой, но для системы это другое устройство.
        let was = scene(d("AirPods", 91, 24000), d("AirPods", 91, 24000));
        let now = scene(d("AirPods", 112, 24000), d("AirPods", 112, 24000));
        assert!(needs_restart(&was, &now, true));
    }

    #[test]
    fn rate_change_restarts() {
        // Наушники перешли из «музыки» (48 кГц) в «гарнитуру» (24 кГц) - поток читал бы звук не с той скоростью.
        let was = scene(d("AirPods", 91, 24000), d("AirPods", 91, 48000));
        let now = scene(d("AirPods", 91, 24000), d("AirPods", 91, 24000));
        assert!(needs_restart(&was, &now, true));
    }

    #[test]
    fn output_change_ignored_without_system_audio() {
        let was = scene(d("Микрофон MacBook Pro", 70, 48000), d("AirPods", 91, 48000));
        let now = scene(d("Микрофон MacBook Pro", 70, 48000), d("Динамики MacBook Pro", 77, 48000));
        assert!(!needs_restart(&was, &now, false));
        assert!(needs_restart(&was, &now, true));
    }

    /// Прогон цикла на заданной последовательности обстановок (по одной на проверку): какие обстановки
    /// ушли в пересоздание. Последняя обстановка повторяется, пока проверки не кончатся.
    fn run(scenes: Vec<Scene>, checks: usize, fail_first: bool) -> Vec<Scene> {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let reads = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(Mutex::new(Vec::new()));
        let failed = Arc::new(AtomicBool::new(!fail_first));
        let timing = WatchTiming {
            tick: Duration::from_millis(1),
            settle: Duration::from_millis(1),
            window: Duration::from_secs(60),
            max_restarts: 6,
        };
        let (r, d, f) = (reads.clone(), done.clone(), failed.clone());
        let read = move || {
            let i = r.fetch_add(1, Ordering::SeqCst);
            scenes[i.min(scenes.len() - 1)].clone()
        };
        let restart = move |s: Scene| -> RestartFuture {
            let (d, f) = (d.clone(), f.clone());
            Box::pin(async move {
                if !f.swap(true, Ordering::SeqCst) {
                    return Err("микрофон не открылся".into());
                }
                d.lock().unwrap().push(s);
                Ok(())
            })
        };
        let alive = move || reads.load(Ordering::SeqCst) < checks;
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(watch(read, restart, alive, true, timing));
        let out = done.lock().unwrap().clone();
        out
    }

    #[test]
    fn watch_follows_headphones_away_and_back() {
        let air = scene(d("AirPods", 91, 24000), d("AirPods", 98, 24000));
        let builtin = scene(d("Микрофон MacBook Pro", 70, 48000), d("Динамики MacBook Pro", 77, 48000));
        let back = scene(d("AirPods", 104, 24000), d("AirPods", 112, 24000));
        let mut seq = vec![air.clone(), air.clone(), builtin.clone(), builtin.clone(), builtin.clone(), builtin.clone()];
        seq.extend(vec![back.clone(); 6]);
        assert_eq!(run(seq, 12, false), vec![builtin, back]);
    }

    #[test]
    fn watch_ignores_one_tick_blip() {
        let air = scene(d("AirPods", 91, 24000), d("AirPods", 98, 24000));
        let other = scene(d("Микрофон MacBook Pro", 70, 48000), d("AirPods", 98, 24000));
        assert!(run(vec![air.clone(), air.clone(), other, air.clone(), air], 8, false).is_empty());
    }

    #[test]
    fn watch_retries_after_failed_restart() {
        let air = scene(d("AirPods", 91, 24000), d("AirPods", 98, 24000));
        let back = scene(d("AirPods", 104, 24000), d("AirPods", 112, 24000));
        // Первое пересоздание не удалось - обстановка не принята, следующая пара проверок пробует снова.
        assert_eq!(run(vec![air, back.clone()], 10, true), vec![back]);
    }

    #[test]
    fn watch_stops_restarting_a_flapping_device() {
        let a = scene(d("AirPods", 91, 24000), d("AirPods", 98, 24000));
        let b = scene(d("AirPods", 91, 24000), d("AirPods", 98, 48000));
        // Частота вывода прыгает каждые 3 проверки - пересозданий не больше 6 за окно.
        let mut seq = vec![a.clone()];
        for i in 0..40 {
            let s = if i % 2 == 0 { b.clone() } else { a.clone() };
            seq.extend(vec![s; 3]);
        }
        assert_eq!(run(seq, 120, false).len(), 6);
    }

    #[test]
    fn missing_device_waits_for_replacement() {
        let was = scene(d("AirPods", 91, 24000), d("AirPods", 91, 24000));
        assert!(!needs_restart(&was, &scene(None, None), true));
    }
}
