//! Как быстро во время записи узнаются «голоса коллег» и не путаются ли (Geo 02.10: «голоса между
//! встречами не сохраняются ... иногда просто очень долго подтягивается»).
//!
//! Встреча проигрывается как во время записи (реплики собеседников по порядку в identify_speaker,
//! пересмотр разметки раз в 30 с), голоса коллег - только из встреч ДО неё. Каждые 10 с звука
//! узнавание пробуется с разными порогами: когда человек узнан впервые и верно ли (сверка с именем,
//! которое у этой реплики в сохранённой встрече).
//!
//! Запуск: voices_live_timing <копия базы> <папка моделей> <id встречи> <wav 16 кГц моно>
use app_lib::audio::{diarization, voices};
use std::collections::{BTreeMap, HashMap};

/// (подпись, секунд речи, похожесть, отрыв от второго)
const CONFIGS: &[(&str, f32, f32, f32)] = &[
    ("сейчас: 20с 0.75 / 0.10", 20.0, 0.75, 0.10),
    ("10с 0.75 / 0.10", 10.0, 0.75, 0.10),
    ("10с 0.80 / 0.15", 10.0, 0.80, 0.15),
    ("6с 0.80 / 0.15", 6.0, 0.80, 0.15),
    ("6с 0.85 / 0.20", 6.0, 0.85, 0.20),
];
const TICK: f64 = 10.0;
/// Метки времени расшифровки отстают от звука записи на ~0.11% (как в voices.rs).
const TIME_SCALE: f64 = 1.0011;

fn unit(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (db, models, meeting, wav) = (&a[1], &a[2], &a[3], &a[4]);
    app_lib::parakeet_engine::commands::set_models_directory_for_tests(std::path::PathBuf::from(models));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (profiles, segs, names) = rt.block_on(async {
        let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}?mode=ro", db)).await.expect("база");
        let (created,): (String,) = sqlx::query_as("SELECT created_at FROM meetings WHERE id = ?")
            .bind(meeting)
            .fetch_one(&pool)
            .await
            .expect("встреча");
        // Голоса коллег - как load_profiles, но только из встреч до этой.
        let rows: Vec<(String, Vec<u8>, f64)> = sqlx::query_as(
            "SELECT sn.display_name, mv.centroid, mv.seconds FROM meeting_voices mv
             JOIN speaker_names sn ON sn.meeting_id = mv.meeting_id AND sn.speaker_key = mv.speaker_key
             JOIN meetings m ON m.id = mv.meeting_id
             WHERE sn.speaker_key LIKE 'system%' AND m.created_at < ?",
        )
        .bind(&created)
        .fetch_all(&pool)
        .await
        .unwrap();
        let mut by: BTreeMap<String, (String, Vec<f32>)> = BTreeMap::new();
        for (name, blob, sec) in rows {
            let shown = name.trim().to_string();
            let key = shown.to_lowercase();
            if shown.is_empty() || key == "вы" || key.starts_with("собеседник") {
                continue;
            }
            let c: Vec<f32> = blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            let w = (sec as f32).min(600.0);
            let e = by.entry(key).or_insert_with(|| (shown.clone(), vec![0.0; c.len()]));
            e.1.iter_mut().zip(&c).for_each(|(s, x)| *s += x * w);
        }
        let profiles: Vec<(String, Vec<f32>)> = by.into_values().map(|(n, s)| (n, unit(s))).collect();
        let segs: Vec<(String, f64, f64)> = sqlx::query_as::<_, (Option<String>, Option<f64>, Option<f64>)>(
            "SELECT speaker, audio_start_time, audio_end_time FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time",
        )
        .bind(meeting)
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .filter_map(|(s, x, y)| Some((s?, x?, y?)))
        .collect();
        let names: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
            "SELECT speaker_key, display_name FROM speaker_names WHERE meeting_id = ?",
        )
        .bind(meeting)
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|(k, n)| (k, n.trim().to_string()))
        .collect();
        (profiles, segs, names)
    });
    println!("голосов коллег из прошлых встреч: {}", profiles.len());
    rt.block_on(async { diarization::init().await.expect("init") });
    diarization::reset();

    let (samples, sr) = pyannote_rs::read_wav(wav).unwrap();
    let srf = sr as f64;
    let mics: Vec<(f64, f64)> = segs.iter().filter(|s| s.0 == "mic").map(|s| (s.1, s.2)).collect();
    // Кто это на самом деле: имя реплики в сохранённой встрече (по ключу начала реплики).
    let truth_of: HashMap<i64, String> = segs
        .iter()
        .filter(|s| s.0.starts_with("system"))
        .map(|s| (diarization::segment_key(s.1), names.get(&s.0).cloned().unwrap_or_else(|| format!("({})", s.0))))
        .collect();
    let dur_of: HashMap<i64, f64> = segs.iter().map(|s| (diarization::segment_key(s.1), s.2 - s.1)).collect();
    let known: std::collections::HashSet<String> = profiles.iter().map(|(n, _)| n.to_lowercase()).collect();
    let mut first_speech: BTreeMap<String, f64> = BTreeMap::new();

    // (конфиг) -> номер -> (время, имя, похожесть, кто на самом деле)
    let mut first: Vec<BTreeMap<usize, (f64, String, f32, String)>> = vec![BTreeMap::new(); CONFIGS.len()];
    let mut next_tick = TICK;
    let mut next_relabel = 30.0;
    let verbose = a.get(5).map(|v| v == "v").unwrap_or(false);
    let check = |t: f64, first: &mut Vec<BTreeMap<usize, (f64, String, f32, String)>>| {
        let voices_now = diarization::live_voices();
        if verbose {
            // По каждому номеру: речь, лучший и второй голос коллег.
            let mut line = format!("  {:5.0} с:", t);
            for (n, c, sec) in &voices_now {
                let mut sims: Vec<(f32, &str)> = profiles
                    .iter()
                    .map(|(name, p)| (c.iter().zip(p).map(|(x, y)| x * y).sum::<f32>(), name.as_str()))
                    .collect();
                sims.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap());
                let (b, bn) = sims.first().copied().unwrap_or((0.0, "-"));
                let s2 = sims.get(1).map(|x| x.0).unwrap_or(0.0);
                line.push_str(&format!(" | №{} {:.0}с {} {:.2} (+{:.2})", n, sec, bn, b, b - s2));
            }
            println!("{}", line);
        }
        // Кто под каждым номером сейчас (больше всего речи).
        let mut who: HashMap<usize, HashMap<String, f64>> = HashMap::new();
        for (key, n) in diarization::live_labels() {
            if n == 0 {
                continue;
            }
            let t = truth_of.get(&key).cloned().unwrap_or_default();
            *who.entry(n).or_default().entry(t).or_default() += dur_of.get(&key).copied().unwrap_or(0.0);
        }
        for (ci, &(_, min_sec, min_sim, margin)) in CONFIGS.iter().enumerate() {
            for (n, name, sim) in voices::match_profiles_with(&voices_now, &profiles, min_sec, min_sim, margin) {
                if first[ci].contains_key(&n) {
                    continue;
                }
                let truth = who
                    .get(&n)
                    .and_then(|m| m.iter().max_by(|x, y| x.1.partial_cmp(y.1).unwrap()).map(|(k, _)| k.clone()))
                    .unwrap_or_default();
                first[ci].insert(n, (t, name, sim, truth));
            }
        }
    };
    for (sp, st, en) in segs.iter() {
        if !sp.starts_with("system") {
            continue;
        }
        while *st >= next_tick {
            if next_tick >= next_relabel {
                diarization::relabel_live();
                next_relabel += 30.0;
            }
            check(next_tick, &mut first);
            next_tick += TICK;
        }
        let truth = truth_of.get(&diarization::segment_key(*st)).cloned().unwrap_or_default();
        first_speech.entry(truth).or_insert(*st);
        let ov: f64 = mics.iter().map(|(x, y)| (en.min(*y) - st.max(*x)).max(0.0)).sum();
        if ov / (en - st).max(1e-6) >= 0.3 {
            continue;
        }
        let (i0, i1) = (((st * TIME_SCALE).max(0.0) * srf) as usize, ((en * TIME_SCALE * srf) as usize).min(samples.len()));
        if i1 <= i0 + 1600 {
            continue;
        }
        let f: Vec<f32> = samples[i0..i1].iter().map(|&x| x as f32 / 32768.0).collect();
        diarization::identify_speaker(&f, sr, false, *st);
    }
    check(next_tick, &mut first);

    println!("\nкто говорил (первая реплика) - есть ли голос из прошлых встреч:");
    for (who, t) in &first_speech {
        println!("  {:24} с {:6.0} с  {}", who, t, if known.contains(&who.to_lowercase()) { "голос есть" } else { "новый" });
    }
    for (ci, (label, ..)) in CONFIGS.iter().enumerate() {
        println!("\n[{}]", label);
        if first[ci].is_empty() {
            println!("  никого не узнал");
        }
        for (n, (t, name, sim, truth)) in &first[ci] {
            let ok = truth.to_lowercase() == name.to_lowercase();
            let wait = first_speech.get(truth).map(|s| t - s).unwrap_or(f64::NAN);
            println!(
                "  номер {:2} на {:6.0} с (через {:4.0} с от первой реплики): {} ({:.2}) - {}",
                n,
                t,
                wait,
                name,
                sim,
                if ok { "верно".to_string() } else { format!("ОШИБКА, это {}", truth) }
            );
        }
    }
}
