//! Родной пайплайн pyannote-rs как в их примере identify:
//! segmentation-3.0 режет на реплики по голосам, wespeaker считает отпечатки,
//! EmbeddingManager кластеризует. Прогон на их же эталонном файле - проверка,
//! работает ли библиотека вообще.
//!
//! Запуск: cargo run --release --example diar_native -- <wav> <seg.onnx> <emb.onnx> <порог>

use pyannote_rs::{EmbeddingExtractor, EmbeddingManager};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wav = args.get(1).expect("wav");
    let seg_model = args.get(2).expect("seg model");
    let emb_model = args.get(3).expect("emb model");
    let threshold: f32 = args.get(4).map(|s| s.parse().unwrap()).unwrap_or(0.5);

    let (samples, sample_rate) = pyannote_rs::read_wav(wav).expect("wav не прочитался");
    eprintln!("wav: {} сэмплов, {} Hz", samples.len(), sample_rate);

    let mut extractor = EmbeddingExtractor::new(emb_model).expect("emb модель");
    let mut manager = EmbeddingManager::new(usize::MAX);

    let segments: Vec<_> = pyannote_rs::get_segments(&samples, sample_rate, seg_model)
        .expect("сегментация")
        .filter_map(|r| r.ok())
        .collect();
    eprintln!("сегментов: {}", segments.len());

    for seg in segments {
        let dur = seg.end - seg.start;
        let emb: Vec<f32> = match extractor.compute(&seg.samples) {
            Ok(it) => it.collect(),
            Err(_) => continue,
        };
        let spk = manager
            .search_speaker(emb, threshold)
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".to_string());
        println!("{:6.1}-{:6.1} ({:4.1}s) -> спикер {}", seg.start, seg.end, dur, spk);
    }
    println!("итого голосов: {}", manager.get_all_speakers().len());

    // Попарные похожести на РОДНЫХ сегментах - сравнение с нашим окномным путём.
    let segments2: Vec<_> = pyannote_rs::get_segments(&samples, sample_rate, seg_model)
        .expect("сегментация")
        .filter_map(|r| r.ok())
        .collect();
    let mut embs: Vec<Vec<f32>> = Vec::new();
    for seg in &segments2 {
        if let Ok(it) = extractor.compute(&seg.samples) {
            embs.push(it.collect());
        }
    }
    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
        let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
    }
    println!("матрица похожестей (родные сегменты):");
    for i in 0..embs.len() {
        let row: Vec<String> = (0..embs.len())
            .map(|j| format!("{:5.2}", cosine(&embs[i], &embs[j])))
            .collect();
        println!("  {}", row.join(" "));
    }
}
