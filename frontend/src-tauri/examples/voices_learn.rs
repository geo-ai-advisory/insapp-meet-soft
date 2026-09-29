//! Голоса коллег на настоящих данных: выучить голоса из встреч с именами (КОПИЯ базы!)
//! и поискать этих людей во встречах лаборатории (отпечатки ~/dev/diar-lab/emb_ok).
//!
//! Запуск: voices_learn <копия meeting_minutes.sqlite> <папка моделей> [~/dev/diar-lab]
use app_lib::audio::{diarization, voices};
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    app_lib::parakeet_engine::commands::set_models_directory_for_tests(PathBuf::from(&a[2]));
    let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", a[1])).await.expect("база");
    sqlx::migrate!("./migrations").run(&pool).await.expect("миграции");
    let t = std::time::Instant::now();
    let n = voices::learn_past_meetings(&pool, None).await;
    println!("выучено встреч: {} за {} с", n, t.elapsed().as_secs());
    let profiles = voices::load_profiles(&pool).await;
    println!("голосов коллег: {}", profiles.len());
    for (i, (na, pa)) in profiles.iter().enumerate() {
        let near = profiles.iter().enumerate().filter(|(j, _)| *j != i)
            .map(|(_, (nb, pb))| (pa.iter().zip(pb).map(|(x, y)| x * y).sum::<f32>(), nb.as_str()))
            .fold((f32::MIN, ""), |b, x| if x.0 > b.0 { x } else { b });
        println!("  {:24} ближайший другой голос: {} ({:.2})", na, near.1, near.0);
    }
    let Some(lab) = a.get(3) else { return };
    let manifest: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(format!("{}/manifest.json", lab)).unwrap()).unwrap();
    println!("\nузнавание во встречах лаборатории (27.08-22.09):");
    for m in &manifest {
        let id = m["id"].as_str().unwrap();
        let Ok(text) = std::fs::read_to_string(format!("{}/emb_ok/{}.jsonl", lab, id)) else { continue };
        let rows: Vec<serde_json::Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        let sp = |r: &serde_json::Value| r["speaker"].as_str().unwrap_or("").to_string();
        let mics: Vec<(f64, f64)> = rows.iter().filter(|r| !sp(r).starts_with("system")).map(|r| (r["start"].as_f64().unwrap(), r["end"].as_f64().unwrap())).collect();
        let mut recs = Vec::new();
        for r in rows.iter().filter(|r| sp(r).starts_with("system")) {
            let (st, en) = (r["start"].as_f64().unwrap(), r["end"].as_f64().unwrap());
            let ov: f64 = mics.iter().map(|(x, y)| (en.min(*y) - st.max(*x)).max(0.0)).sum();
            if ov / (en - st).max(1e-6) >= 0.3 || en - st < 1.5 { continue; }
            let mut e: Vec<f32> = r["emb"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
            let nn = e.iter().map(|x| x * x).sum::<f32>().sqrt(); e.iter_mut().for_each(|x| *x /= nn);
            recs.push(diarization::GuestRecord { at: st, dur: (en - st) as f32, emb: Some(e), live: 0 });
        }
        if recs.len() < 3 { continue; }
        let labels = diarization::final_relabel(&recs);
        let vs = diarization::voices_of(&recs, &labels);
        let found = voices::match_profiles(&vs, &profiles);
        if !found.is_empty() {
            let who: Vec<String> = found.iter().map(|(_, n, s)| format!("{} {:.2}", n, s)).collect();
            println!("  {} {:40} -> {}", id, m["title"].as_str().unwrap_or(""), who.join(", "));
        }
    }
}
