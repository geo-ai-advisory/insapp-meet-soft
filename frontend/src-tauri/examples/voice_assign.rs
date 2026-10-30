//! Кто из собеседников говорит в каждом куске: отпечаток голоса куска против голосов собеседников этой
//! встречи (meeting_voices). Нужен, когда расшифровку куска встречи восстанавливают по звуку записи.
//!
//! Запуск: voice_assign <база> <id встречи> <wav 16 кГц моно> <начало wav, с записи> <куски.json> <папка моделей>
//!   куски.json - [{"start": с, "end": с}, ...] во времени записи; ответ в stdout - JSON по кускам:
//!   {"best": "system_3", "score": 0.81, "second": 0.55} или null (кусок короче секунды).
use app_lib::audio::diarization::{model_path, VoiceModel};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (db, meeting, wav, segs_path, models) = (&a[1], &a[2], &a[3], &a[5], &a[6]);
    let offset: f64 = a[4].parse().expect("начало wav");
    app_lib::parakeet_engine::commands::set_models_directory_for_tests(std::path::PathBuf::from(models));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let voices: Vec<(String, Vec<f32>)> = rt.block_on(async {
        let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}?mode=ro", db)).await.expect("база");
        sqlx::query_as::<_, (String, Vec<u8>)>("SELECT speaker_key, centroid FROM meeting_voices WHERE meeting_id = ?")
            .bind(meeting)
            .fetch_all(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(k, b)| (k, b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()))
            .collect()
    });
    eprintln!("голосов собеседников в встрече: {}", voices.len());
    let mut model = VoiceModel::load(&model_path().expect("папка моделей")).expect("модель голоса");
    let (samples, sr) = pyannote_rs::read_wav(wav).unwrap();
    let srf = sr as f64;
    let segs: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(segs_path).unwrap()).unwrap();
    let mut out = Vec::new();
    for s in &segs {
        let (st, en) = (s["start"].as_f64().unwrap() - offset, s["end"].as_f64().unwrap() - offset);
        let (i0, i1) = ((((st + 0.1).max(0.0)) * srf) as usize, (((en - 0.1) * srf) as usize).min(samples.len()));
        if i1 <= i0 + sr as usize {
            out.push(serde_json::Value::Null);
            continue;
        }
        let f: Vec<f32> = samples[i0..i1].iter().map(|&x| x as f32 / 32768.0).collect();
        let Some(e) = model.embed(&f) else {
            out.push(serde_json::Value::Null);
            continue;
        };
        let mut sims: Vec<(f32, &str)> =
            voices.iter().map(|(k, c)| (e.iter().zip(c).map(|(x, y)| x * y).sum::<f32>(), k.as_str())).collect();
        sims.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(std::cmp::Ordering::Equal));
        out.push(serde_json::json!({
            "best": sims.first().map(|s| s.1),
            "score": sims.first().map(|s| s.0),
            "second": sims.get(1).map(|s| s.0),
        }));
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
