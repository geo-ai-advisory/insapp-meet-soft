//! Пересобрать резюме встречи и заново отправить встречу на сервер - тем же кодом, что приложение, без окна.
//! Нужен после ручной правки в базе (например, перепутанных имён участников): кнопка «Переделать резюме» делает
//! то же самое, но только из открытого приложения.
//!
//! Запуск: resummarize <база приложения> <id встречи>
//!   база: ~/Library/Application Support/tech.insap.meet/meeting_minutes.sqlite (можно при открытом приложении)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (db, meeting) = (&a[1], &a[2]);
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", db)).await.expect("база");
        let started = std::time::Instant::now();
        match app_lib::pty_terminal_commands::summarize_headless(&pool, meeting).await {
            Ok(md) => println!("резюме готово за {:.0} с, {} знаков", started.elapsed().as_secs_f64(), md.chars().count()),
            Err(e) => {
                println!("резюме не получилось: {}", e);
                return;
            }
        }
        match app_lib::insapp_server_commands::upload_meeting_by_id(&pool, meeting.to_string()).await {
            Ok(v) => println!("на сервер: {}", v),
            Err(e) => println!("на сервер не ушло: {}", e),
        }
    });
}
