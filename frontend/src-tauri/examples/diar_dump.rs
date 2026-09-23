//! Выгрузка голосовых отпечатков ВСЕХ реплик встречи - той же моделью и тем же
//! кодом, что работает в приложении. Нужна для оффлайн-подбора алгоритма
//! разделения говорящих на реальных встречах.
//!
//! Запуск: cargo run --release --example diar_dump -- <wav 16k mono> <transcripts.json> <model.onnx> <out.jsonl>
//! Каждая строка out.jsonl: {"i","start","end","speaker","text","emb":[512]}

use pyannote_rs::EmbeddingExtractor;
use std::io::Write;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (wav, tj, model, out) = (&a[1], &a[2], &a[3], &a[4]);

    let (samples, sr) = pyannote_rs::read_wav(wav).expect("wav");
    let sr = sr as f64;
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(tj).expect("json")).expect("parse");
    let segs = raw.as_array().cloned()
        .or_else(|| raw.get("transcripts").and_then(|v| v.as_array()).cloned())
        .or_else(|| raw.get("segments").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();

    let mut ex = EmbeddingExtractor::new(model).expect("model");
    let mut f = std::io::BufWriter::new(std::fs::File::create(out).expect("out"));
    let (mut ok, mut skipped) = (0usize, 0usize);
    for (i, s) in segs.iter().enumerate() {
        let start = s.get("audio_start_time").and_then(|v| v.as_f64());
        let end = s.get("audio_end_time").and_then(|v| v.as_f64())
            .or_else(|| start.zip(s.get("duration").and_then(|v| v.as_f64())).map(|(a, d)| a + d));
        let (Some(st), Some(en)) = (start, end) else { skipped += 1; continue };
        let (a0, a1) = ((st * sr) as usize, ((en * sr) as usize).min(samples.len()));
        if a1 <= a0 + (0.3 * sr) as usize { skipped += 1; continue; }
        let emb: Vec<f32> = match ex.compute(&samples[a0..a1]) { Ok(it) => it.collect(), Err(_) => { skipped += 1; continue } };
        let rec = serde_json::json!({
            "i": i, "start": st, "end": en,
            "speaker": s.get("speaker").cloned().unwrap_or(serde_json::Value::Null),
            "text": s.get("text").cloned().unwrap_or(serde_json::Value::Null),
            "emb": emb,
        });
        writeln!(f, "{}", rec).unwrap();
        ok += 1;
    }
    eprintln!("реплик с отпечатком: {} | пропущено: {}", ok, skipped);
}
