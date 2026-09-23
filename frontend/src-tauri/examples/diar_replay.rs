//! Прогон НАСТОЯЩЕЙ логики приложения (audio::diarization) на записанной встрече.
//! Реплики собеседника подаются по порядку, как во время записи.
//! Реплики, наложенные на речь владельца (>30%), пропускаем: в общем файле записи
//! там громче владелец, а в приложении канал собеседника чистый.
//!
//! Запуск: diar_replay <wav 16k> <aligned transcripts.json> <папка моделей>
use app_lib::audio::diarization::{self, SpeakerRole};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    app_lib::parakeet_engine::commands::set_models_directory_for_tests(std::path::PathBuf::from(&a[3]));
    tokio::runtime::Runtime::new().unwrap().block_on(async { diarization::init().await.expect("init") });
    diarization::reset();

    let (samples, sr) = pyannote_rs::read_wav(&a[1]).unwrap();
    let segs: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
    let t = |s: &serde_json::Value, k: &str| s.get(k).and_then(|v| v.as_f64());
    let is_sys = |s: &serde_json::Value| s.get("speaker").and_then(|v| v.as_str()).map(|x| x.starts_with("system")).unwrap_or(false);
    let mics: Vec<(f64, f64)> = segs.iter().filter(|s| !is_sys(s)).filter_map(|s| Some((t(s, "audio_start_time")?, t(s, "audio_end_time")?))).collect();

    let mut dur_by: std::collections::BTreeMap<usize, f64> = Default::default();
    let mut labels = Vec::new();
    for s in segs.iter().filter(|s| is_sys(s)) {
        let (Some(st), Some(en)) = (t(s, "audio_start_time"), t(s, "audio_end_time")) else { continue };
        let ov: f64 = mics.iter().map(|(a, b)| (en.min(*b) - st.max(*a)).max(0.0)).sum();
        if ov / (en - st).max(1e-6) >= 0.3 { continue; }
        let (i0, i1) = ((st.max(0.0) * sr as f64) as usize, ((en * sr as f64) as usize).min(samples.len()));
        if i1 <= i0 + 1600 { continue; }
        let f: Vec<f32> = samples[i0..i1].iter().map(|&x| x as f32 / 32768.0).collect();
        let role = diarization::identify_speaker(&f, sr, false, st);
        if let SpeakerRole::Guest(n) = role { *dur_by.entry(n).or_default() += en - st; }
        labels.push(serde_json::json!({"start": st, "role": format!("{:?}", role)}));
    }
    let total: f64 = dur_by.values().sum::<f64>().max(1e-6);
    let big = dur_by.values().filter(|v| **v / total >= 0.03).count();
    let shares: Vec<String> = dur_by.iter().map(|(k, v)| format!("{}:{:.0}%", k, v / total * 100.0)).collect();
    println!("собеседников: {} (значимых {}) | {}", dur_by.len(), big, shares.join(" "));
}
