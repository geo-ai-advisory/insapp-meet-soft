use crate::api::{MeetingDetails, MeetingTranscript};
use crate::database::models::{MeetingModel, Transcript};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, SqliteConnection, SqlitePool};
use tracing::{error, info};

pub struct MeetingsRepository;

impl MeetingsRepository {
    /// Список встреч. Если owner задан - только встречи этой учётки (изоляция
    /// по логину). None - все (для внутренних задач без фильтра).
    pub async fn get_meetings(
        pool: &SqlitePool,
        owner: Option<&str>,
    ) -> Result<Vec<MeetingModel>, sqlx::Error> {
        let meetings = match owner {
            Some(login) => {
                sqlx::query_as::<_, MeetingModel>(
                    "SELECT * FROM meetings WHERE owner_login = ? ORDER BY created_at DESC",
                )
                .bind(login)
                .fetch_all(pool)
                .await?
            }
            None => {
                sqlx::query_as::<_, MeetingModel>(
                    "SELECT * FROM meetings ORDER BY created_at DESC",
                )
                .fetch_all(pool)
                .await?
            }
        };
        Ok(meetings)
    }

    /// Встречи, у которых ещё НЕТ резюме и которые пользователь не пометил
    /// как «не предлагать». Для кнопки массового создания резюме.
    /// Возвращает (id, название, дата, длительность в минутах).
    pub async fn get_meetings_without_summary(
        pool: &SqlitePool,
        owner: Option<&str>,
    ) -> Result<Vec<(String, String, String, f64)>, SqlxError> {
        // Резюме живут в summary_processes (status='completed'), а не в transcripts.
        let sql = "
            SELECT m.id, m.title, m.created_at,
                   -- CAST обязателен: если у встречи нет длительности, COALESCE
                   -- отдаёт целое 0, и чтение в дробное падало - список приходил
                   -- пустым, а кнопка «Резюме для всех» говорила «все с резюме».
                   CAST(COALESCE((SELECT MAX(t.audio_end_time) FROM transcripts t
                             WHERE t.meeting_id = m.id), 0) AS REAL) AS dur
            FROM meetings m
            WHERE COALESCE(m.summary_opt_out, 0) = 0
              AND NOT EXISTS (
                    SELECT 1 FROM summary_processes s
                    WHERE s.meeting_id = m.id AND s.status = 'completed'
              )
              AND EXISTS (SELECT 1 FROM transcripts t WHERE t.meeting_id = m.id)
              AND (? IS NULL OR m.owner_login = ?)
            ORDER BY m.created_at DESC";
        // Параметр в запросе встречается дважды - биндим оба раза явно.
        // С нумерованным ?1 sqlx ждал два значения и запрос не выполнялся,
        // из-за чего список встреч всегда приходил пустым.
        let rows: Vec<(String, String, String, f64)> = sqlx::query_as(sql)
            .bind(owner)
            .bind(owner)
            .fetch_all(pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|(id, title, created, secs)| (id, title, created, (secs / 60.0).round()))
            .collect())
    }

    /// Отметить, что расшифровка (или резюме) встречи успешно ушли на сервер.
    /// По этим отметкам список встреч показывает облачко «загружено».
    pub async fn mark_synced(
        pool: &SqlitePool,
        meeting_id: &str,
        kind: &str, // "transcript" | "summary"
    ) -> Result<(), SqlxError> {
        let now = Utc::now().to_rfc3339();
        let sql = if kind == "summary" {
            "UPDATE meetings SET summary_synced_at = ? WHERE id = ?"
        } else {
            "UPDATE meetings SET transcript_synced_at = ? WHERE id = ?"
        };
        sqlx::query(sql).bind(&now).bind(meeting_id).execute(pool).await?;
        Ok(())
    }

    /// Статусы для списка встреч: есть ли расшифровка/резюме и ушли ли на сервер.
    /// Возвращает id -> (есть транскрипт, транскрипт на сервере, есть резюме, резюме на сервере).
    pub async fn get_status_flags(
        pool: &SqlitePool,
    ) -> Result<std::collections::HashMap<String, (bool, bool, bool, bool)>, SqlxError> {
        let rows: Vec<(String, i64, Option<String>, i64, Option<String>)> = sqlx::query_as(
            "SELECT m.id,
                    EXISTS(SELECT 1 FROM transcripts t WHERE t.meeting_id = m.id) AS has_tr,
                    m.transcript_synced_at,
                    EXISTS(SELECT 1 FROM summary_processes s
                           WHERE s.meeting_id = m.id AND s.status = 'completed') AS has_sum,
                    m.summary_synced_at
             FROM meetings m",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, has_tr, tr_sync, has_sum, sum_sync)| {
                (id, (has_tr != 0, tr_sync.is_some(), has_sum != 0, sum_sync.is_some()))
            })
            .collect())
    }

    /// Пометить встречу «больше не предлагать резюме» (или снять пометку).
    pub async fn set_summary_opt_out(
        pool: &SqlitePool,
        meeting_id: &str,
        opt_out: bool,
    ) -> Result<(), SqlxError> {
        sqlx::query("UPDATE meetings SET summary_opt_out = ? WHERE id = ?")
            .bind(if opt_out { 1_i64 } else { 0_i64 })
            .bind(meeting_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Длительность каждой встречи в МИНУТАХ (id -> минуты).
    /// Считаем по последней реплике - отдельного поля длительности в базе нет,
    /// а счётчику «Расшифровано» на главной эти цифры нужны.
    pub async fn get_durations_minutes(
        pool: &SqlitePool,
    ) -> Result<std::collections::HashMap<String, f64>, SqlxError> {
        let rows: Vec<(String, Option<f64>)> = sqlx::query_as(
            "SELECT meeting_id, MAX(audio_end_time) FROM transcripts
             WHERE audio_end_time IS NOT NULL GROUP BY meeting_id",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, secs)| secs.map(|s| (id, (s / 60.0).round())))
            .collect())
    }

    pub async fn delete_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        match delete_meeting_with_transaction(&mut transaction, meeting_id).await {
            Ok(success) => {
                if success {
                    transaction.commit().await?;
                    info!(
                        "Successfully deleted meeting {} and all associated data",
                        meeting_id
                    );
                    Ok(true)
                } else {
                    transaction.rollback().await?;
                    Ok(false)
                }
            }
            Err(e) => {
                let _ = transaction.rollback().await;
                error!("Failed to delete meeting {}: {}", meeting_id, e);
                Err(e)
            }
        }
    }

    pub async fn get_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingDetails>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        // Get meeting details
        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT id, title, created_at, updated_at, folder_path, meeting_type FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(&mut *transaction)
                .await?;

        if meeting.is_none() {
            transaction.rollback().await?;
            return Err(SqlxError::RowNotFound);
        }

        if let Some(meeting) = meeting {
            // Get all transcripts for this meeting
            let transcripts =
                sqlx::query_as::<_, Transcript>("SELECT * FROM transcripts WHERE meeting_id = ?")
                    .bind(meeting_id)
                    .fetch_all(&mut *transaction)
                    .await?;

            transaction.commit().await?;

            // Convert Transcript to MeetingTranscript
            let meeting_transcripts = transcripts
                .into_iter()
                .map(|t| MeetingTranscript {
                    id: t.id,
                    text: t.transcript,
                    timestamp: t.timestamp,
                    audio_start_time: t.audio_start_time,
                    audio_end_time: t.audio_end_time,
                    duration: t.duration,
                    speaker: t.speaker,
                })
                .collect::<Vec<_>>();

            Ok(Some(MeetingDetails {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                transcripts: meeting_transcripts,
                meeting_type: crate::api::normalize_meeting_type(meeting.meeting_type),
            }))
        } else {
            transaction.rollback().await?;
            Ok(None)
        }
    }

    /// Get meeting metadata without transcripts (for pagination)
    pub async fn get_meeting_metadata(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingModel>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT id, title, created_at, updated_at, folder_path, meeting_type FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(pool)
                .await?;

        Ok(meeting)
    }

    /// Get meeting transcripts with pagination support
    pub async fn get_meeting_transcripts_paginated(
        pool: &SqlitePool,
        meeting_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<Transcript>, i64), SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        // Get total count of transcripts for this meeting
        let total: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?"
        )
        .bind(meeting_id)
        .fetch_one(pool)
        .await?;

        // Get paginated transcripts ordered by audio_start_time
        let transcripts = sqlx::query_as::<_, Transcript>(
            "SELECT * FROM transcripts
             WHERE meeting_id = ?
             ORDER BY audio_start_time ASC
             LIMIT ? OFFSET ?"
        )
        .bind(meeting_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;

        Ok((transcripts, total.0))
    }

    pub async fn update_meeting_title(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now().naive_utc();

        let rows_affected =
            sqlx::query("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?")
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;
        if rows_affected.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }
        transaction.commit().await?;
        Ok(true)
    }

    /// Обновить тип встречи: 'internal' (Внутренняя) | 'external' (Внешняя).
    pub async fn update_meeting_type(
        pool: &SqlitePool,
        meeting_id: &str,
        meeting_type: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }
        // Нормализуем: всё, кроме 'external', считаем 'internal'.
        let normalized = if meeting_type == "external" { "external" } else { "internal" };
        let now = Utc::now().naive_utc();
        let rows_affected =
            sqlx::query("UPDATE meetings SET meeting_type = ?, updated_at = ? WHERE id = ?")
                .bind(normalized)
                .bind(now)
                .bind(meeting_id)
                .execute(pool)
                .await?;
        Ok(rows_affected.rows_affected() > 0)
    }

    /// Пометить встречу как локальную (true) или разрешённую к выгрузке (false).
    /// Ставится при сохранении со снятой галочкой «Отправить в облако».
    pub async fn set_cloud_opt_out(
        pool: &SqlitePool,
        meeting_id: &str,
        opt_out: bool,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol("meeting_id cannot be empty".to_string()));
        }
        let value: i64 = if opt_out { 1 } else { 0 };
        let rows_affected =
            sqlx::query("UPDATE meetings SET cloud_opt_out = ? WHERE id = ?")
                .bind(value)
                .bind(meeting_id)
                .execute(pool)
                .await?;
        Ok(rows_affected.rows_affected() > 0)
    }

    /// Прочитать признак локальности встречи (true = не выгружать на сервер).
    pub async fn get_cloud_opt_out(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol("meeting_id cannot be empty".to_string()));
        }
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT cloud_opt_out FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(pool)
                .await?;
        Ok(row.map(|(v,)| v != 0).unwrap_or(false))
    }

    pub async fn update_meeting_name(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        let mut transaction = pool.begin().await?;
        let now = Utc::now();

        // Update meetings table
        let meeting_update =
            sqlx::query("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?")
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;

        if meeting_update.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false); // Meeting not found
        }

        // Update transcript_chunks table
        sqlx::query("UPDATE transcript_chunks SET meeting_name = ? WHERE meeting_id = ?")
            .bind(new_title)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(true)
    }
}

async fn delete_meeting_with_transaction(
    transaction: &mut SqliteConnection,
    meeting_id: &str,
) -> Result<bool, SqlxError> {
    // Check if meeting exists
    let meeting_exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(&mut *transaction)
        .await?;

    if meeting_exists.is_none() {
        error!("Meeting {} not found for deletion", meeting_id);
        return Ok(false);
    }

    // Delete from related tables in proper order
    // 1. Delete from transcript_chunks
    sqlx::query("DELETE FROM transcript_chunks WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 2. Delete from summary_processes
    sqlx::query("DELETE FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 3. Delete from transcripts
    sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 4. Finally, delete the meeting
    let result = sqlx::query("DELETE FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    Ok(result.rows_affected() > 0)
}
