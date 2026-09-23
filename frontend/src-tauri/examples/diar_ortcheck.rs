//! Где ломается отпечаток: один и тот же кусок звука через разные способы запуска модели.
//! Эталон (официальный onnxruntime в Python): [0.2922, -0.0555, -0.1404, -0.6092, 0.4742]
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

fn run(level: GraphOptimizationLevel, flat: bool, feats: &ndarray::Array2<f32>, model: &str) -> Vec<f32> {
    let mut s = Session::builder().unwrap().with_optimization_level(level).unwrap()
        .with_intra_threads(1).unwrap().commit_from_file(model).unwrap();
    let (t, b) = (feats.shape()[0], feats.shape()[1]);
    let out = if flat {
        let data: Vec<f32> = feats.iter().copied().collect();
        let tensor = Tensor::from_array(([1usize, t, b], data)).unwrap();
        s.run(ort::inputs!["feats" => tensor]).unwrap()
    } else {
        let f3 = feats.clone().insert_axis(ndarray::Axis(0));
        s.run(ort::inputs!["feats" => Tensor::from_array(f3).unwrap()]).unwrap()
    };
    let (_, d) = out.get("embs").unwrap().try_extract_tensor::<f32>().unwrap();
    d[..5].to_vec()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (samples, sr) = pyannote_rs::read_wav(&a[1]).unwrap();
    let seg = &samples[(46.50 * sr as f64) as usize..(52.85 * sr as f64) as usize];
    let mut f = vec![0.0f32; seg.len()];
    knf_rs::convert_integer_to_float_audio(seg, &mut f);
    let feats = knf_rs::compute_fbank(&f).unwrap();
    
    for name in ["Level3 (как в приложении)", "Level2", "Level1", "Disable (без оптимизаций)"] {
        let lvl = || match name { n if n.starts_with("Level3") => GraphOptimizationLevel::Level3, "Level2" => GraphOptimizationLevel::Level2, "Level1" => GraphOptimizationLevel::Level1, _ => GraphOptimizationLevel::Disable };
        println!("{name:28} ndarray: {:?}", run(lvl(), false, &feats, &a[2]));
        let t0 = std::time::Instant::now();
        for _ in 0..20 { run(lvl(), true, &feats, &a[2]); }
        println!("{name:28} время на 20 запусков: {:?}", t0.elapsed());
    }
}
