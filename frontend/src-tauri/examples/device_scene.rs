//! Что видит слежение за устройствами (audio::device_watch): раз в секунду - нужный микрофон и вывод по
//! умолчанию (имя, номер устройства в системе, частота). Только чтение, звук не открывается.
//!
//! Запуск: device_scene [секунд] [выбранный микрофон]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let secs: u64 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(5);
    app_lib::audio::device_watch::set_preferred_mic(a.get(2).cloned());
    let mut last = None;
    for i in 0..secs {
        let s = app_lib::audio::device_watch::read_scene();
        if last.as_ref() != Some(&s) {
            println!(
                "{:4} с  микрофон {}  |  вывод {}",
                i,
                app_lib::audio::device_watch::describe(&s.mic),
                app_lib::audio::device_watch::describe(&s.output)
            );
            last = Some(s);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
