//! Голоса коллег: имя, данное человеку в одной встрече, узнаётся в следующих.
//!
//! Идея Geo (29.09.2026): «я в одной встрече сохранил имя человека - почему не подставить
//! его во все будущие встречи, состав со стороны Insapp всегда похожий». Замер на его
//! встречах (журнал Projects/insapp-meet/journals/2026-09-29-speakers-klimov-listopad,
//! voice_profiles_check.py): тот же человек в другой встрече - похожесть центров голоса
//! 0.84-0.94, чужие голоса в той же встрече - 0.40-0.55 (осколок того же человека - до 0.74).
//!
//! Как устроено:
//! - при сохранении встречи центр голоса каждого собеседника пишется в meeting_voices;
//! - имя метки (speaker_names) + её голос = «голос коллеги»; голоса одного имени из разных
//!   встреч складываются (профиль считается на лету, отдельной таблицы нет - переименовал
//!   метку, и профиль сразу поправился);
//! - во время записи и при сохранении собеседник с уверенным совпадением получает имя
//!   сам; имя, которое дал пользователь, всегда главнее;
//! - встречи с именами, записанные до этой функции, выучиваются по звуку (learn_past_meetings).
//! Всё хранится только на этом компьютере: голос для узнавания человека - биометрия.

use crate::audio::diarization::{self, GuestRecord, VoiceModel};
use sqlx::SqlitePool;
use tracing::{info, warn};

/// Имя подставляется, только если голос похож на профиль не меньше чем на это...
const MATCH_MIN: f32 = 0.75;
/// ...и заметно ближе, чем на второй по похожести профиль.
const MATCH_MARGIN: f32 = 0.10;
/// Узнаём собеседника, когда он наговорил хотя бы столько секунд (отпечаток устойчив) - при сохранении.
const MIN_VOICE_SEC: f32 = 20.0;
/// Во время записи - раньше: 10 с речи. Geo 02.10: «иногда очень долго подтягивается» - с 20 с и
/// проверкой раз в 30 с человек ждал имени до 2,5 минут. Прогон 9 встреч Geo с 29.09 по 02.10
/// (examples/voices_live_timing.rs, журнал 2026-10-02-voices-between-meetings): с 10 с - ни одной
/// ошибки, узнавание быстрее (Марикс: 133 -> 23 с, Фомичев: 33 -> 13 с, Радаев: 60 -> 40 с).
/// Строже похожесть (0.80) не брать: на «АБ Техничке» Радаев узнавался бы через 18 минут вместо минуты.
const LIVE_MIN_VOICE_SEC: f32 = 10.0;
/// Выучиваем прошлые встречи только с 23.09.2026: раньше разметка собеседников была
/// испорчена (см. журнал 2026-09-23-diarization-quality), имена там висят на смесях голосов.
const LEARN_SINCE: &str = "2026-09-23";
/// Метки времени расшифровки отстают от звука записи на ~0.11% (замер 23.09).
const TIME_SCALE: f64 = 1.0011;

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Сопоставить голоса встречи с голосами коллег.
///
/// `voices` - (номер собеседника, центр голоса, секунд речи); `profiles` - (имя, центр).
/// Возвращает только уверенные пары (номер, имя, похожесть): не меньше MATCH_MIN и с отрывом
/// MATCH_MARGIN от второго профиля. Одно имя - одному собеседнику и наоборот (лучшие первыми).
pub fn match_profiles(voices: &[(usize, Vec<f32>, f32)], profiles: &[(String, Vec<f32>)]) -> Vec<(usize, String, f32)> {
    match_profiles_with(voices, profiles, MIN_VOICE_SEC, MATCH_MIN, MATCH_MARGIN)
}

/// Узнавание во время записи: те же пороги похожести, но хватает 10 с речи.
pub fn match_profiles_live(voices: &[(usize, Vec<f32>, f32)], profiles: &[(String, Vec<f32>)]) -> Vec<(usize, String, f32)> {
    match_profiles_with(voices, profiles, LIVE_MIN_VOICE_SEC, MATCH_MIN, MATCH_MARGIN)
}

/// То же с заданными порогами (для проверочных прогонов на записанных встречах).
pub fn match_profiles_with(
    voices: &[(usize, Vec<f32>, f32)],
    profiles: &[(String, Vec<f32>)],
    min_sec: f32,
    min_sim: f32,
    margin: f32,
) -> Vec<(usize, String, f32)> {
    let mut cands: Vec<(usize, String, f32)> = Vec::new();
    for (n, c, sec) in voices {
        if *sec < min_sec || c.is_empty() {
            continue;
        }
        let mut sims: Vec<(f32, &str)> = profiles
            .iter()
            .filter(|(_, p)| p.len() == c.len())
            .map(|(name, p)| (dot(c, p), name.as_str()))
            .collect();
        sims.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(&(best, name)) = sims.first() {
            let second = sims.get(1).map(|s| s.0).unwrap_or(0.0);
            if best >= min_sim && best - second >= margin {
                cands.push((*n, name.to_string(), best));
            }
        }
    }
    cands.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let mut used_n = std::collections::HashSet::new();
    let mut used_name = std::collections::HashSet::new();
    cands
        .into_iter()
        .filter(|(n, name, _)| {
            let key = name.to_lowercase();
            if used_n.contains(n) || used_name.contains(&key) {
                return false;
            }
            used_n.insert(*n);
            used_name.insert(key);
            true
        })
        .collect()
}

/// Голоса коллег: имя -> центр голоса по всем встречам, где этой метке дано имя.
pub async fn load_profiles(pool: &SqlitePool) -> Vec<(String, Vec<f32>)> {
    let rows: Vec<(String, Vec<u8>, f64)> = sqlx::query_as(
        "SELECT sn.display_name, mv.centroid, mv.seconds
         FROM meeting_voices mv
         JOIN speaker_names sn ON sn.meeting_id = mv.meeting_id AND sn.speaker_key = mv.speaker_key
         WHERE sn.speaker_key LIKE 'system%'",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let mut by: Vec<(String, String, Vec<f32>)> = Vec::new(); // (ключ, имя для показа, сумма)
    for (name, blob, sec) in rows {
        let shown = name.trim().to_string();
        let key = shown.to_lowercase();
        // «Вы» у собеседника - его реплики слиты с вашими (эхо вашего голоса); «Собеседник N» - слит
        // с безымянным голосом. Это не имена коллег - голоса под ними не запоминаем.
        if shown.is_empty() || key == "вы" || key.starts_with("собеседник") {
            continue;
        }
        let c = from_blob(&blob);
        let w = (sec as f32).min(600.0);
        match by.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, _, sum)) if sum.len() == c.len() => sum.iter_mut().zip(&c).for_each(|(a, x)| *a += x * w),
            Some(_) => {}
            None => by.push((key, shown, c.iter().map(|x| x * w).collect())),
        }
    }
    by.into_iter()
        .filter_map(|(_, name, mut s)| {
            let n = s.iter().map(|x| x * x).sum::<f32>().sqrt();
            if n == 0.0 {
                return None;
            }
            s.iter_mut().for_each(|x| *x /= n);
            Some((name, s))
        })
        .collect()
}

/// Сохранить голоса собеседников встречи (метка «system_N» -> центр и секунды).
pub async fn save_meeting_voices(pool: &SqlitePool, meeting_id: &str, voices: &[(usize, Vec<f32>, f32)]) {
    for (n, c, sec) in voices {
        let r = sqlx::query(
            "INSERT INTO meeting_voices (meeting_id, speaker_key, centroid, seconds) VALUES (?, ?, ?, ?)
             ON CONFLICT(meeting_id, speaker_key) DO UPDATE SET centroid = excluded.centroid, seconds = excluded.seconds",
        )
        .bind(meeting_id)
        .bind(format!("system_{}", n))
        .bind(to_blob(c))
        .bind(*sec as f64)
        .execute(pool)
        .await;
        if let Err(e) = r {
            warn!("[voices] не сохранить голос {} встречи {}: {}", n, meeting_id, e);
        }
    }
}

/// Подписать собеседников встречи по голосам коллег - тех, кому имя ещё не дано.
/// Имена, уже стоящие во встрече, второй раз не выдаются. Возвращает число подписанных.
pub async fn auto_name_meeting(pool: &SqlitePool, meeting_id: &str, voices: &[(usize, Vec<f32>, f32)]) -> usize {
    let named: Vec<(String, String)> =
        crate::database::repositories::transcript::TranscriptsRepository::get_speaker_names(pool, meeting_id)
            .await
            .unwrap_or_default();
    let named_keys: std::collections::HashSet<String> = named.iter().map(|(k, _)| k.clone()).collect();
    let named_names: std::collections::HashSet<String> = named.iter().map(|(_, n)| n.trim().to_lowercase()).collect();
    let profiles: Vec<(String, Vec<f32>)> = load_profiles(pool)
        .await
        .into_iter()
        .filter(|(n, _)| !named_names.contains(&n.to_lowercase()))
        .collect();
    let free: Vec<(usize, Vec<f32>, f32)> = voices
        .iter()
        .filter(|(n, _, _)| !named_keys.contains(&format!("system_{}", n)))
        .cloned()
        .collect();
    let mut count = 0;
    for (n, name, sim) in match_profiles(&free, &profiles) {
        let r = sqlx::query(
            "INSERT INTO speaker_names (meeting_id, speaker_key, display_name) VALUES (?, ?, ?)
             ON CONFLICT(meeting_id, speaker_key) DO NOTHING",
        )
        .bind(meeting_id)
        .bind(format!("system_{}", n))
        .bind(&name)
        .execute(pool)
        .await;
        if r.is_ok() {
            info!("[voices] встреча {}: собеседник {} узнан по голосу - {} ({:.2})", meeting_id, n, name, sim);
            count += 1;
        }
    }
    count
}

/// Выучить голоса одной встречи по звуку записи (встречи, сохранённые до этой функции).
/// Метки собеседников пересматриваются так же, как после записи (с сохранением номеров),
/// поэтому имена меток попадают к правильным голосам.
fn learn_from_audio(
    model: &mut VoiceModel,
    audio: &std::path::Path,
    segs: &[(String, f64, f64)],
) -> Result<Vec<(usize, Vec<f32>, f32)>, String> {
    let decoded = crate::audio::decoder::decode_audio_file(audio).map_err(|e| format!("не прочитать звук: {}", e))?;
    let x = decoded.to_whisper_format(); // 16 кГц моно
    let sr = 16000.0f64;
    let mics: Vec<(f64, f64)> = segs.iter().filter(|s| s.0 == "mic").map(|s| (s.1, s.2)).collect();
    let mut records = Vec::new();
    for (sp, st, en) in segs {
        if !sp.starts_with("system") {
            continue;
        }
        let live = sp.strip_prefix("system_").and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
        // реплики поверх речи владельца в общем файле звучат его голосом - пропускаем
        let ov: f64 = mics.iter().map(|(a, b)| (en.min(*b) - st.max(*a)).max(0.0)).sum();
        if ov / (en - st).max(1e-6) >= 0.3 {
            continue;
        }
        let (a, b) = (st * TIME_SCALE + 0.15, en * TIME_SCALE - 0.15);
        if b - a < 1.5 {
            continue;
        }
        let (i0, i1) = ((a * sr) as usize, ((b * sr) as usize).min(x.len()));
        if i1 <= i0 + 16000 {
            continue;
        }
        if let Some(e) = model.embed(&x[i0..i1]) {
            records.push(GuestRecord { at: *st, dur: (b - a) as f32, emb: Some(e), live });
        }
    }
    if records.is_empty() {
        return Ok(Vec::new());
    }
    let labels = diarization::relabel_impl(&records, None, &Default::default());
    Ok(diarization::voices_of(&records, &labels))
}

/// Выучить голоса прошлых встреч, где собеседникам даны имена, а голоса ещё не сохранены.
/// Тяжёлая часть (звук, отпечатки) - в отдельном потоке. Возвращает число выученных встреч.
pub async fn learn_past_meetings(pool: &SqlitePool, only_meeting: Option<&str>) -> usize {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT DISTINCT m.id, m.folder_path FROM meetings m
         JOIN speaker_names sn ON sn.meeting_id = m.id AND sn.speaker_key LIKE 'system%'
         WHERE m.created_at >= ?
           AND NOT EXISTS (SELECT 1 FROM meeting_voices mv WHERE mv.meeting_id = m.id)
           AND (? IS NULL OR m.id = ?)",
    )
    .bind(LEARN_SINCE)
    .bind(only_meeting)
    .bind(only_meeting)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if rows.is_empty() {
        return 0;
    }
    let model_path = match diarization::model_path() {
        Some(p) if p.exists() => p,
        _ => return 0,
    };
    let mut learned = 0;
    for (meeting_id, folder) in rows {
        let Some(folder) = folder else { continue };
        let audio = std::path::Path::new(&folder).join("audio.mp4");
        if !audio.exists() {
            continue;
        }
        let segs: Vec<(String, f64, f64)> = sqlx::query_as::<_, (Option<String>, Option<f64>, Option<f64>)>(
            "SELECT speaker, audio_start_time, audio_end_time FROM transcripts WHERE meeting_id = ?",
        )
        .bind(&meeting_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(sp, a, b)| Some((sp?, a?, b?)))
        .collect();
        let mp = model_path.clone();
        let started = std::time::Instant::now();
        let res = tokio::task::spawn_blocking(move || {
            let mut model = VoiceModel::load(&mp)?;
            learn_from_audio(&mut model, &audio, &segs)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        match res {
            Ok(voices) if !voices.is_empty() => {
                save_meeting_voices(pool, &meeting_id, &voices).await;
                info!(
                    "[voices] выучены голоса встречи {}: собеседников {}, за {} с",
                    meeting_id,
                    voices.len(),
                    started.elapsed().as_secs()
                );
                learned += 1;
            }
            Ok(_) => {}
            Err(e) => warn!("[voices] встреча {}: {}", meeting_id, e),
        }
    }
    learned
}

/// Голоса коллег для Настроек: имя, в скольких встречах, сколько минут речи.
#[tauri::command]
pub async fn voices_list(state: tauri::State<'_, crate::state::AppState>) -> Result<Vec<serde_json::Value>, String> {
    let pool = state.db_manager.pool();
    let rows: Vec<(String, i64, f64)> = sqlx::query_as(
        "SELECT sn.display_name, COUNT(DISTINCT mv.meeting_id), SUM(mv.seconds)
         FROM meeting_voices mv
         JOIN speaker_names sn ON sn.meeting_id = mv.meeting_id AND sn.speaker_key = mv.speaker_key
         WHERE sn.speaker_key LIKE 'system%' AND trim(sn.display_name) NOT IN ('Вы', 'вы', 'ВЫ') AND trim(sn.display_name) NOT LIKE 'Собеседник%' -- lower() в SQLite не знает кириллицу
         GROUP BY lower(trim(sn.display_name)) ORDER BY SUM(mv.seconds) DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(name, meetings, sec)| serde_json::json!({ "name": name.trim(), "meetings": meetings, "minutes": (sec / 60.0).round() }))
        .collect())
}

/// Забыть голос коллеги (имена во встречах остаются, узнавание по голосу - нет).
#[tauri::command]
pub async fn voices_forget(state: tauri::State<'_, crate::state::AppState>, name: String) -> Result<u64, String> {
    let pool = state.db_manager.pool();
    let r = sqlx::query(
        "DELETE FROM meeting_voices WHERE (meeting_id, speaker_key) IN
           (SELECT meeting_id, speaker_key FROM speaker_names WHERE lower(trim(display_name)) = lower(trim(?)))",
    )
    .bind(&name)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    // У SQLite lower() знает только латиницу - дочищаем кириллицу сравнением в Rust.
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT mv.meeting_id, mv.speaker_key, sn.display_name FROM meeting_voices mv
         JOIN speaker_names sn ON sn.meeting_id = mv.meeting_id AND sn.speaker_key = mv.speaker_key",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let key = name.trim().to_lowercase();
    let mut extra = 0;
    for (m, k, n) in rows {
        if n.trim().to_lowercase() == key {
            let _ = sqlx::query("DELETE FROM meeting_voices WHERE meeting_id = ? AND speaker_key = ?")
                .bind(&m)
                .bind(&k)
                .execute(pool)
                .await;
            extra += 1;
        }
    }
    Ok(r.rows_affected() + extra)
}

/// Выучить голоса из прошлых встреч с именами сейчас (кнопка в Настройках).
#[tauri::command]
pub async fn voices_learn_now(state: tauri::State<'_, crate::state::AppState>) -> Result<usize, String> {
    if crate::audio::recording_commands::is_recording_now() {
        return Err("Идёт запись - выучу голоса после неё".to_string());
    }
    Ok(learn_past_meetings(state.db_manager.pool(), None).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: Vec<f32>) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.into_iter().map(|x| x / n).collect()
    }

    #[test]
    fn confident_match_only_and_one_name_per_person() {
        let anna = unit(vec![1.0, 0.0, 0.0]);
        let dima = unit(vec![0.0, 1.0, 0.0]);
        let profiles = vec![("Анна".to_string(), anna.clone()), ("Дима".to_string(), dima.clone())];
        let voices = vec![
            (1, unit(vec![0.95, 0.1, 0.1]), 60.0),  // Анна
            (2, unit(vec![0.1, 0.9, 0.2]), 45.0),   // Дима
            (3, unit(vec![0.6, 0.55, 0.3]), 80.0),  // похож на обоих - не угадываем
            (4, unit(vec![0.97, 0.05, 0.0]), 10.0), // мало речи
        ];
        let m = match_profiles(&voices, &profiles);
        assert_eq!(m.len(), 2, "{:?}", m);
        assert!(m.iter().any(|(n, name, _)| *n == 1 && name == "Анна"));
        assert!(m.iter().any(|(n, name, _)| *n == 2 && name == "Дима"));
    }

    #[test]
    fn same_name_goes_to_best_voice_only() {
        let anna = unit(vec![1.0, 0.0, 0.0]);
        let profiles = vec![("Анна".to_string(), anna)];
        let voices = vec![(1, unit(vec![0.9, 0.3, 0.0]), 60.0), (2, unit(vec![0.99, 0.05, 0.0]), 60.0)];
        let m = match_profiles(&voices, &profiles);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].0, 2);
    }

    #[test]
    fn live_recognizes_after_ten_seconds_save_after_twenty() {
        let anna = unit(vec![1.0, 0.0, 0.0]);
        let profiles = vec![("Анна".to_string(), anna.clone()), ("Дима".to_string(), unit(vec![0.0, 1.0, 0.0]))];
        let voices = vec![(1, unit(vec![0.95, 0.1, 0.1]), 12.0)];
        assert_eq!(match_profiles_live(&voices, &profiles).len(), 1);
        assert!(match_profiles(&voices, &profiles).is_empty());
        let short = vec![(1, unit(vec![0.95, 0.1, 0.1]), 8.0)];
        assert!(match_profiles_live(&short, &profiles).is_empty());
    }

    #[test]
    fn blob_roundtrip() {
        let v = vec![0.25f32, -1.5, 3.0];
        assert_eq!(from_blob(&to_blob(&v)), v);
    }
}
