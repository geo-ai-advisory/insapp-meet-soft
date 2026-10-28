//! Имена «голосов коллег» во время записи и после сохранения - по старому правилу окна записи и по новому.
//!
//! Встреча проигрывается как во время записи (реплики собеседников по порядку в identify_speaker, раз в
//! 10 с узнавание, раз в 30 с пересмотр разметки), окно записи повторено здесь же:
//!  - старое: имя получает только безымянный номер и только свободное имя; приложению уходят все имена
//!    как данные пользователем (номер закреплён за именем);
//!  - новое (useSpeakerNames.applyRecognized): угаданное имя идёт за голосом, приложению уходят только
//!    имена пользователя (в прогоне их нет);
//!  - новое + закрепление: имя идёт за голосом, но приложению уходят все имена, как раньше.
//! После «остановки» - сохранение: итоговая разметка, подпись по голосу (как auto_name_meeting), перенос
//! имён окна (старое - поверх всего, новое - как pickLiveNamesToSave).
//! Правда - имена реплик в сохранённой и проверенной встрече. Считаем секунды речи под чужим именем.
//!
//! Запуск: names_live_replay <копия базы> <папка моделей> <id встречи> <wav 16 кГц моно> [секунда для снимка]
//!   PROFILES_DB=<копия базы> - голоса коллег из другой копии (например, какими они были в день записи).
use app_lib::audio::{diarization, voices};
use std::collections::{BTreeMap, HashMap, HashSet};

const TICK: f64 = 10.0;
/// Метки времени расшифровки отстают от звука записи на ~0.11% (как в voices.rs).
const TIME_SCALE: f64 = 1.0011;

#[derive(Clone, Copy, PartialEq)]
enum Rule {
    Old,
    New,
    NewPinned,
}

fn unit(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

fn same(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

fn mmss(t: f64) -> String {
    format!("{:02}:{:02}", (t as i64) / 60, (t as i64) % 60)
}

/// Окно записи: номер -> имя и какие имена угаданы по голосу.
#[derive(Default)]
struct Window {
    names: BTreeMap<usize, String>,
    auto: HashSet<usize>,
}

impl Window {
    /// Событие speakers-recognized. true - имена изменились.
    fn recognized(&mut self, rule: Rule, items: &[(usize, String, f32)]) -> bool {
        let mut changed = false;
        for (n, name, _) in items {
            if rule == Rule::Old {
                if self.names.contains_key(n) || self.names.values().any(|v| same(v, name)) {
                    continue;
                }
            } else {
                if let Some(cur) = self.names.get(n) {
                    if !self.auto.contains(n) || same(cur, name) {
                        continue;
                    }
                }
                let holder = self.names.iter().find(|(k, v)| *k != n && same(v, name)).map(|(k, _)| *k);
                if let Some(h) = holder {
                    if !self.auto.contains(&h) {
                        continue;
                    }
                    self.names.remove(&h);
                    self.auto.remove(&h);
                }
            }
            self.names.insert(*n, name.clone());
            self.auto.insert(*n);
            changed = true;
        }
        changed
    }

    /// Что окно отдаёт приложению (diarization_set_live_names).
    fn pinned(&self, rule: Rule) -> HashMap<String, String> {
        self.names
            .iter()
            .filter(|(n, _)| rule != Rule::New || !self.auto.contains(*n))
            .map(|(n, v)| (format!("system_{}", n), v.clone()))
            .collect()
    }
}

struct Meeting {
    profiles: Vec<(String, Vec<f32>)>,
    segs: Vec<(String, f64, f64)>,
    /// Кто это на самом деле (имя метки в сохранённой встрече; None - метка без имени).
    truth_of: HashMap<i64, Option<String>>,
    dur_of: HashMap<i64, f64>,
}

impl Meeting {
    /// Секунды речи под чужим именем при разметке `labels` (ключ реплики, номер) и именах `names`.
    fn wrong(&self, labels: &[(i64, usize)], names: &BTreeMap<usize, String>) -> (f64, BTreeMap<(String, String), f64>) {
        let mut total = 0.0;
        let mut by = BTreeMap::new();
        for (key, n) in labels {
            let (Some(name), Some(Some(truth))) = (names.get(n), self.truth_of.get(key)) else { continue };
            if !same(name, truth) {
                let d = self.dur_of.get(key).copied().unwrap_or(0.0);
                total += d;
                *by.entry((name.clone(), truth.clone())).or_insert(0.0) += d;
            }
        }
        (total, by)
    }

    /// Кто говорит под номером: главный по речи и его доля.
    fn who(&self, labels: &[(i64, usize)], n: usize) -> String {
        let mut by: BTreeMap<String, f64> = BTreeMap::new();
        for (key, l) in labels {
            if *l == n {
                let t = self.truth_of.get(key).cloned().flatten().unwrap_or_else(|| "?".into());
                *by.entry(t).or_insert(0.0) += self.dur_of.get(key).copied().unwrap_or(0.0);
            }
        }
        let total: f64 = by.values().sum();
        match by.into_iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap()) {
            Some((t, d)) if total > 0.0 => format!("{} {:.0}% из {:.0} с", t, d / total * 100.0, total),
            _ => "пусто".into(),
        }
    }
}

async fn load(db: &str, meeting: &str) -> Meeting {
    let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}?mode=ro", db)).await.expect("база");
    let (created,): (String,) = sqlx::query_as("SELECT created_at FROM meetings WHERE id = ?")
        .bind(meeting)
        .fetch_one(&pool)
        .await
        .expect("встреча");
    // Голоса коллег - как load_profiles, но только из встреч до этой (их знало приложение на записи).
    let ppool = match std::env::var("PROFILES_DB") {
        Ok(p) => sqlx::SqlitePool::connect(&format!("sqlite:{}?mode=ro", p)).await.expect("база голосов"),
        Err(_) => pool.clone(),
    };
    let rows: Vec<(String, Vec<u8>, f64)> = sqlx::query_as(
        "SELECT sn.display_name, mv.centroid, mv.seconds FROM meeting_voices mv
         JOIN speaker_names sn ON sn.meeting_id = mv.meeting_id AND sn.speaker_key = mv.speaker_key
         JOIN meetings m ON m.id = mv.meeting_id
         WHERE sn.speaker_key LIKE 'system%' AND m.created_at < ?",
    )
    .bind(&created)
    .fetch_all(&ppool)
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
    let names: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT speaker_key, display_name FROM speaker_names WHERE meeting_id = ?")
            .bind(meeting)
            .fetch_all(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(k, n)| (k, n.trim().to_string()))
            .collect();
    let truth_of = segs
        .iter()
        .filter(|s| s.0.starts_with("system"))
        .map(|s| (diarization::segment_key(s.1), names.get(&s.0).cloned()))
        .collect();
    let dur_of = segs.iter().map(|s| (diarization::segment_key(s.1), s.2 - s.1)).collect();
    Meeting { profiles, segs, truth_of, dur_of }
}

fn run(rt: &tokio::runtime::Runtime, rule: Rule, m: &Meeting, samples: &[i16], sr: u32, snap_at: Option<f64>) {
    println!(
        "\n==== {} ====",
        match rule {
            Rule::Old => "старое правило окна записи",
            Rule::New => "новое правило окна записи",
            Rule::NewPinned => "новое правило, угаданные имена закреплены в приложении",
        }
    );
    rt.block_on(async { diarization::init().await.expect("init") });
    diarization::reset();
    diarization::set_profiles(m.profiles.clone());
    let srf = sr as f64;
    let mics: Vec<(f64, f64)> = m.segs.iter().filter(|s| s.0 == "mic").map(|s| (s.1, s.2)).collect();
    let mut w = Window::default();
    let (mut tick, mut next_tick) = (0u64, TICK);
    let (mut wrong_sum, mut ticks, mut peak, mut snapped) = (0.0f64, 0usize, (0.0f64, 0.0f64), false);

    let mut on_tick = |t: f64, tick: u64, w: &mut Window| {
        if tick % 3 == 0 {
            diarization::relabel_live();
        }
        let known = diarization::recognize_live();
        if w.recognized(rule, &known) {
            diarization::diarization_set_live_names(w.pinned(rule));
            let labels = diarization::live_labels();
            let line: Vec<String> =
                w.names.iter().map(|(n, name)| format!("№{} {} [{}]", n, name, m.who(&labels, *n))).collect();
            println!("  {}  {}", mmss(t), line.join(" | "));
        }
        let labels = diarization::live_labels();
        let (wr, _) = m.wrong(&labels, &w.names);
        wrong_sum += wr;
        ticks += 1;
        if wr > peak.0 {
            peak = (wr, t);
        }
        if let Some(s) = snap_at {
            if !snapped && t >= s {
                snapped = true;
                let mut nums: Vec<usize> = labels.iter().map(|(_, n)| *n).filter(|n| *n > 0).collect();
                nums.sort_unstable();
                nums.dedup();
                println!("  -- снимок на {}: что видно на экране --", mmss(t));
                for n in nums {
                    let shown = w.names.get(&n).cloned().unwrap_or_else(|| format!("Собеседник {}", n));
                    println!("     №{:2} «{}»: говорит {}", n, shown, m.who(&labels, n));
                }
            }
        }
    };

    for (sp, st, en) in m.segs.iter() {
        if !sp.starts_with("system") {
            continue;
        }
        while *st >= next_tick {
            tick += 1;
            on_tick(next_tick, tick, &mut w);
            next_tick += TICK;
        }
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
    tick += 1;
    on_tick(next_tick, tick, &mut w);

    // Остановка и сохранение: итоговая разметка, подпись по голосу, перенос имён окна.
    let live = diarization::live_labels();
    diarization::unload();
    let fin = diarization::take_final_relabel().unwrap_or_default();
    let labels: Vec<(i64, usize)> = live.iter().map(|(k, n)| (*k, fin.get(k).copied().unwrap_or(*n))).collect();
    let mut saved: BTreeMap<usize, String> = voices::match_profiles(&diarization::take_final_voices(), &m.profiles)
        .into_iter()
        .map(|(n, name, _)| (n, name))
        .collect();
    let mut used: HashSet<String> = saved.values().map(|v| v.trim().to_lowercase()).collect();
    for (n, name) in &w.names {
        if rule != Rule::Old && w.auto.contains(n) && (saved.contains_key(n) || used.contains(&name.trim().to_lowercase())) {
            continue;
        }
        saved.insert(*n, name.clone());
        used.insert(name.trim().to_lowercase());
    }
    let (end_live, _) = m.wrong(&live, &w.names);
    let (end_saved, by) = m.wrong(&labels, &saved);
    println!("  сохранено: {}", saved.iter().map(|(n, v)| format!("№{} {} [{}]", n, v, m.who(&labels, *n))).collect::<Vec<_>>().join(" | "));
    println!(
        "  ИТОГ: под чужим именем по ходу записи в среднем {:.0} с речи (пик {:.0} с на {}), в конце записи {:.0} с, после сохранения {:.0} с",
        wrong_sum / ticks.max(1) as f64,
        peak.0,
        mmss(peak.1),
        end_live,
        end_saved
    );
    for ((name, truth), d) in by {
        println!("     после сохранения: «{}» на речи {} - {:.0} с", name, truth, d);
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (db, models, meeting, wav) = (&a[1], &a[2], &a[3], &a[4]);
    let snap_at: Option<f64> = a.get(5).and_then(|s| s.parse().ok());
    app_lib::parakeet_engine::commands::set_models_directory_for_tests(std::path::PathBuf::from(models));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let m = rt.block_on(load(db, meeting));
    println!("голосов коллег из прошлых встреч: {}, реплик: {}", m.profiles.len(), m.segs.len());
    let (samples, sr) = pyannote_rs::read_wav(wav).unwrap();
    for rule in [Rule::Old, Rule::New, Rule::NewPinned] {
        run(&rt, rule, &m, &samples, sr, snap_at);
    }
}
