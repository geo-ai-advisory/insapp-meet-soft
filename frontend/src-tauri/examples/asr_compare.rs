//! Сравнение моделей распознавания на движке приложения (Geo 13.10: «возможно, есть модель лучше» -
//! Parakeet Ultra против текущей Parakeet TDT 0.6b v3; методика как у замера GigaAM 25.08: одно и то же
//! аудио реальных встреч, один и тот же способ прогона).
//!
//! Звук режется на куски до 28 с по самым тихим местам - нарезка зависит только от звука, поэтому
//! обе модели получают одинаковые куски. Каждый кусок идёт в ParakeetModel::transcribe_samples,
//! как реплика в приложении.
//!
//! Запуск: asr_compare <папка модели> <итог.json> <звук f32le 16 кГц моно>...
//!   ASR_STEP=0..3 - режим шага по кадрам (ParakeetModel::set_step_mode): 0 - как сейчас в приложении,
//!   1 - по длительностям TDT, 2 - длительность > 0 = шаг на кадр, 3 - как 0 без повтора токена на кадре.
//!   ffmpeg -i audio.mp4 -ss 0 -t 600 -ac 1 -ar 16000 -f f32le clip.f32
use app_lib::parakeet_engine::ParakeetModel;
use std::time::Instant;

const RATE: usize = 16_000;
/// Кусок не короче и не длиннее (секунды): резать ищем в этом окне.
const MIN_CHUNK: f64 = 18.0;
const MAX_CHUNK: f64 = 28.0;
/// Кадр громкости и ширина «тихого места».
const FRAME: usize = RATE / 50;
const QUIET_FRAMES: usize = 15;

fn read_f32le(path: &str) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("не прочитать {}: {}", path, e));
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

/// Границы кусков в отсчётах: каждый раз - середина самого тихого места в окне MIN_CHUNK..MAX_CHUNK.
fn cut_points(samples: &[f32]) -> Vec<usize> {
    let energy: Vec<f64> = samples
        .chunks(FRAME)
        .map(|f| f.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>() / f.len() as f64)
        .collect();
    let frames = |sec: f64| (sec * RATE as f64 / FRAME as f64) as usize;
    let mut cuts = vec![0usize];
    let mut at = 0usize;
    while at + frames(MAX_CHUNK) < energy.len() {
        let (lo, hi) = (at + frames(MIN_CHUNK), at + frames(MAX_CHUNK));
        let mut best = (f64::MAX, lo);
        for i in lo..hi.saturating_sub(QUIET_FRAMES) {
            let e: f64 = energy[i..i + QUIET_FRAMES].iter().sum();
            if e < best.0 {
                best = (e, i + QUIET_FRAMES / 2);
            }
        }
        at = best.1;
        cuts.push(at * FRAME);
    }
    cuts.push(samples.len());
    cuts
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 4 {
        eprintln!("asr_compare <папка модели> <итог.json> <звук f32le 16 кГц моно>...");
        std::process::exit(2);
    }
    let (model_dir, out) = (&a[1], &a[2]);
    let started = Instant::now();
    let mut model = ParakeetModel::new(model_dir, true).expect("модель не загрузилась");
    let step_mode: u8 = std::env::var("ASR_STEP").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    model.set_step_mode(step_mode);
    let load_sec = started.elapsed().as_secs_f64();

    let mut files = Vec::new();
    for path in &a[3..] {
        let samples = read_f32le(path);
        let cuts = cut_points(&samples);
        let run = Instant::now();
        let mut chunks = Vec::new();
        for w in cuts.windows(2) {
            let text = match model.transcribe_samples(samples[w[0]..w[1]].to_vec()) {
                Ok(r) => r.text.trim().to_string(),
                Err(e) => format!("<ошибка: {}>", e),
            };
            chunks.push(serde_json::json!({
                "start": w[0] as f64 / RATE as f64,
                "end": w[1] as f64 / RATE as f64,
                "text": text,
            }));
        }
        let audio_sec = samples.len() as f64 / RATE as f64;
        let run_sec = run.elapsed().as_secs_f64();
        eprintln!("{}: {:.0} с звука за {:.1} с ({:.1}x)", path, audio_sec, run_sec, audio_sec / run_sec);
        files.push(serde_json::json!({
            "file": path,
            "audio_sec": audio_sec,
            "run_sec": run_sec,
            "chunks": chunks,
        }));
    }
    let report = serde_json::json!({ "model_dir": model_dir, "step_mode": step_mode, "load_sec": load_sec, "files": files });
    std::fs::write(out, serde_json::to_string_pretty(&report).unwrap()).expect("не записать итог");
}
