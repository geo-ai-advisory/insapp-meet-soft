//! Голоса и имена встречи, возвращённой в базу без обычного сохранения (запись не остановилась):
//! как при сохранении - голоса собеседников по звуку записи и меткам фраз (save_meeting_voices) и подпись
//! тех, кого приложение знает по прошлым встречам (auto_name_meeting). Имена, данные вручную, не трогает.
//!
//! Запуск: restore_names <meeting_minutes.sqlite> <папка моделей> <id встречи>
use app_lib::audio::{diarization, voices};
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (db, models, meeting) = (&a[1], &a[2], &a[3]);
    app_lib::parakeet_engine::commands::set_models_directory_for_tests(PathBuf::from(models));
    let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", db)).await.expect("база");
    let (folder,): (String,) = sqlx::query_as("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(meeting)
        .fetch_one(&pool)
        .await
        .expect("встреча");
    let segs: Vec<(String, f64, f64)> = sqlx::query_as(
        "SELECT speaker, audio_start_time, audio_end_time FROM transcripts
         WHERE meeting_id = ? AND speaker IS NOT NULL AND audio_start_time IS NOT NULL",
    )
    .bind(meeting)
    .fetch_all(&pool)
    .await
    .expect("фразы");
    let audio = PathBuf::from(&folder).join("audio.mp4");
    let t = std::time::Instant::now();
    let mut model = diarization::VoiceModel::load(&diarization::model_path().expect("папка моделей")).expect("модель голоса");
    let v = voices::learn_from_audio(&mut model, &audio, &segs).expect("голоса");
    println!("голосов собеседников: {} за {} с", v.len(), t.elapsed().as_secs());
    for (n, _, sec) in &v {
        println!("  system_{}: {:.0} с речи", n, sec);
    }
    voices::save_meeting_voices(&pool, meeting, &v).await;
    let named = voices::auto_name_meeting(&pool, meeting, &v).await;
    println!("подписано по голосу: {}", named);
    let names: Vec<(String, String)> =
        sqlx::query_as("SELECT speaker_key, display_name FROM speaker_names WHERE meeting_id = ? ORDER BY speaker_key")
            .bind(meeting)
            .fetch_all(&pool)
            .await
            .unwrap();
    for (k, n) in names {
        println!("  {} -> {}", k, n);
    }
}
