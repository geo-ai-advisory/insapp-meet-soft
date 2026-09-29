//! Прогон НАСТОЯЩЕЙ логики приложения: разметка во время записи (identify_speaker)
//! + разметка после встречи (final_relabel при выгрузке модели).
//! Реплики, наложенные на речь владельца (>30%), пропускаем: в общем файле записи
//! там громче владелец, а в приложении канал собеседника чистый.
//!
//! Запуск: diar_final <wav 16k> <transcripts.json (выровненный)> <папка моделей> [итог.json]
use app_lib::audio::diarization::{self, SpeakerRole};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    app_lib::parakeet_engine::commands::set_models_directory_for_tests(std::path::PathBuf::from(&a[3]));
    tokio::runtime::Runtime::new().unwrap().block_on(async { diarization::init().await.expect("init") });
    diarization::reset();

    let (samples, sr) = pyannote_rs::read_wav(&a[1]).unwrap();
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
    let segs: Vec<serde_json::Value> = raw.get("segments").and_then(|v| v.as_array()).cloned()
        .unwrap_or_else(|| raw.as_array().cloned().unwrap_or_default());
    let t = |s: &serde_json::Value, k: &str| s.get(k).and_then(|v| v.as_f64());
    let is_sys = |s: &serde_json::Value| s.get("speaker").and_then(|v| v.as_str()).map(|x| x.starts_with("system")).unwrap_or(false);
    let mics: Vec<(f64, f64)> = segs.iter().filter(|s| !is_sys(s)).filter_map(|s| Some((t(s, "audio_start_time")?, t(s, "audio_end_time")?))).collect();

    let mut out = Vec::new();
    // Что видно на экране: номер реплики с учётом пересмотров раз в 30 с (как в приложении).
    let mut shown: std::collections::HashMap<i64, usize> = Default::default();
    let mut last_relabel = 0.0f64;
    let mut relabels = 0usize;
    for s in segs.iter().filter(|s| is_sys(s)) {
        let (Some(st), Some(en)) = (t(s, "audio_start_time"), t(s, "audio_end_time")) else { continue };
        let ov: f64 = mics.iter().map(|(a, b)| (en.min(*b) - st.max(*a)).max(0.0)).sum();
        if ov / (en - st).max(1e-6) >= 0.3 { continue; }
        let (i0, i1) = ((st.max(0.0) * sr as f64) as usize, ((en * sr as f64) as usize).min(samples.len()));
        if i1 <= i0 + 1600 { continue; }
        let f: Vec<f32> = samples[i0..i1].iter().map(|&x| x as f32 / 32768.0).collect();
        let role = diarization::identify_speaker(&f, sr, false, st);
        let live = match role { SpeakerRole::Guest(n) => n, _ => 0 };
        shown.insert(diarization::segment_key(st), live);
        out.push((st, en - st, live, s.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string()));
        if std::env::var("LIVE_RELABEL").is_ok() && st - last_relabel >= 30.0 {
            last_relabel = st;
            for (k, n) in diarization::relabel_live() {
                shown.insert(k, n);
                relabels += 1;
            }
        }
    }
    let t0 = std::time::Instant::now();
    diarization::unload(); // здесь считается разметка после встречи
    let map = diarization::take_final_relabel().unwrap_or_default();
    let ms = t0.elapsed().as_millis();

    let share = |pick: &dyn Fn(&(f64, f64, usize, String)) -> usize| {
        let mut by: std::collections::BTreeMap<usize, f64> = Default::default();
        for r in &out { let n = pick(r); if n > 0 { *by.entry(n).or_default() += r.1; } }
        let total: f64 = by.values().sum::<f64>().max(1e-6);
        let parts: Vec<String> = by.iter().map(|(k, v)| format!("{}:{:.0}%", k, v / total * 100.0)).collect();
        format!("{} соб. | {}", by.len(), parts.join(" "))
    };
    let fin = |r: &(f64, f64, usize, String)| *map.get(&diarization::segment_key(r.0)).unwrap_or(&r.2);
    println!("во время записи: {}", share(&|r| r.2));
    if std::env::var("LIVE_RELABEL").is_ok() {
        println!("на экране к концу (с пересмотром, перекрашено {}): {}", relabels,
                 share(&|r| *shown.get(&diarization::segment_key(r.0)).unwrap_or(&r.2)));
    }
    println!("после встречи:  {}  ({} мс)", share(&fin), ms);
    if let Some(p) = a.get(4) {
        let rows: Vec<serde_json::Value> = out.iter().map(|r| serde_json::json!({"t": r.0, "d": r.1, "live": r.2,
            "shown": *shown.get(&diarization::segment_key(r.0)).unwrap_or(&r.2), "final": fin(r), "text": r.3})).collect();
        std::fs::write(p, serde_json::to_string(&rows).unwrap()).unwrap();
    }
}
