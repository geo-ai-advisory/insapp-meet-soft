//! Вычитка расшифровки на КОПИИ базы приложения - тем же кодом, что в приложении (transcript_polish::polish_meeting):
//! тот же промпт, куски, проверка правок, запись в transcripts.polished. Чтобы показать «было / стало» до выпуска.
//!
//! Запуск: polish_try <копия базы> <id встречи> [модель]
//!   копия: sqlite3 meeting_minutes.sqlite ".backup '<копия>'" - миграции приложения применяются к копии.
use app_lib::pty_terminal_commands::AiSummarySettings;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (db, meeting) = (&a[1], &a[2]);
    let mut settings = AiSummarySettings::default();
    if let Some(m) = a.get(3) {
        settings.model = m.clone();
    }
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", db)).await.expect("база");
        sqlx::migrate!("./migrations").run(&pool).await.expect("миграции");
        let started = std::time::Instant::now();
        match app_lib::transcript_polish::polish_meeting(&pool, meeting, &settings).await {
            Ok(st) => println!(
                "реплик {}, исправлено {}, убрано {}, отклонено {} за {:.0} с",
                st.lines,
                st.changed,
                st.removed,
                st.rejected,
                started.elapsed().as_secs_f64()
            ),
            Err(e) => println!("ошибка: {} (через {:.0} с)", e, started.elapsed().as_secs_f64()),
        }
    });
}
