//! Вычитка расшифровки после встречи.
//!
//! Geo 14.10.2026: «после каждой встречи генерится резюме, но расшифровку никто не корректирует... пусть Claude
//! по моему словарику и памяти поправит - "опишка" через «о» станет API, названия компаний, имена, фамилии,
//! паразиты, кривые и полупустые реплики, артефакты» (пример: «ф ф ф ф ф ф ф ф ф функциональности своей страны»).
//!
//! Делает тот же Claude (или Codex), что пишет резюме, с памятью пользователя - в том же фоновом задании, параллельно
//! с резюме (резюме не ждёт: часовая встреча вычитывается 5-10 минут). Исходный текст распознавания не трогаем:
//! вычитанный лежит рядом (transcripts.polished), экран встречи умеет показать «как распознано». После вычитки
//! расшифровка заново уходит на сервер - ссылка «Поделиться» показывает чистый текст.
//!
//! Модели отдаём реплики с номерами кусками по LINES_PER_CALL, назад просим только изменённые строки в JSON.
//! Каждую правку проверяем: модель не должна дописывать от себя или выбрасывать смысл (`accept`).

use crate::pty_terminal_commands::{run_cli_attempt, summary_attempts, AiSummarySettings, AUTH_ERROR};
use sqlx::SqlitePool;
use std::collections::HashMap;
use tauri::Emitter;

/// Сколько реплик отдаём модели за один запрос: ответ должен уместиться в одно сообщение модели (на пробе 14.10
/// 250 реплик с обычным усилием дали обрезанный ответ - дошли последние 7 правок). Часовая встреча (~500 реплик) -
/// четыре запроса, идут по три одновременно, каждый ~1 минута с низким усилием.
const LINES_PER_CALL: usize = 150;
/// Встреча короче - вычитывать нечего (проверка звука, случайный старт).
const MIN_LINES: usize = 8;

const PROMPT: &str = "Ниже кусок расшифровки встречи «{title}». Расшифровку делало распознавание речи на слух, \
поэтому в ней ошибки. Каждая строка: [номер] время Имя: текст. Участники встречи: {people}.

РЕЖИМ: работа делается в фоне, собеседника нет - не задавай вопросов и не пиши ничего, кроме ответа в формате ниже.

Сделай вычитку - исправь расшифровку так, как её записал бы внимательный человек, который слышал разговор:
1. Имена, фамилии, названия компаний, партнёров, продуктов и термины пиши так, как они записаны у тебя в памяти \
и инструкциях (CLAUDE.md, AGENTS.md, память проекта, списки правильного написания). Если там их нет - как они \
пишутся на самом деле: «апишка», «опишка», «апи» - это API (три латинские буквы: «дадите API», «по API»); \
так же NDA, CPA, MCC, SDK и т.п.
2. Слова, которые распознались неправильно, восстанавливай по смыслу этой и соседних реплик, но только на слово, \
которое ЗВУЧИТ похоже на распознанное («функциональности своей страны» -> «функциональности со своей стороны», \
«на смесь назад» -> «месяц назад», но не «неделю назад»). Даты, суммы, сроки и числа не угадывай.
3. Убери мусор распознавания: повторы одного звука или слова подряд («ф ф ф ф», «в в в в»), бессмысленные обрывки, \
случайные английские слова посреди русской речи.
4. Убери слова-паразиты (ну, вот, как бы, типа, короче, это самое, э-э), если без них смысл не меняется; \
повтор слова при запинке оставь один раз («я я думаю» -> «я думаю»).
5. Расставь знаки препинания и заглавные буквы.
6. Ничего не добавляй от себя, не пересказывай, не сокращай мысль и не меняй смысл. Короткие ответы («да», «угу», \
«понял») оставляй. Если не уверен, что было сказано на самом деле, - оставь как есть.
7. Строку удаляй целиком, только если в ней нет ни одного осмысленного слова. Если после мусора есть осмысленные \
слова («ф ф ф ф функциональности своей страны»), оставь их и исправь. Слова между строками не переноси, строки \
не объединяй.

Правила из памяти о формате ответов в чате здесь не действуют: формат задаёт этот запрос.
Ответ: только изменённые строки, по одной на строку, в виде JSON {\"n\": номер, \"text\": \"исправленный текст\"}. \
Строку, которую надо удалить, - {\"n\": номер, \"text\": \"\"}. Строки без изменений не выводи; имя и время не пиши, \
только текст реплики. Весь ответ - между строками <<<ВЫЧИТКА и ВЫЧИТКА>>>, без пояснений.

";

/// «Апишка», «опишку», «опихи», «апи» - это API: модель на пробе 14.10 оставляла «опишку» даже с правилом в промпте,
/// поэтому заменяем сами, после модели и во всех репликах (Geo 14.10: «о пишка через о - заменить на API, три буквы»).
static API_SLANG: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r"(?i)\b(?:[ао]пи(?:шк|х)[а-яё]*|апи)\b").expect("regex")
});

/// Слова-термины, которые вычитка исправляет сама, без модели.
pub fn fix_terms(text: &str) -> String {
    API_SLANG.replace_all(text, "API").into_owned()
}

/// Реплика, как её видит модель.
#[derive(Debug, Clone)]
pub struct Line {
    pub n: usize,
    pub id: String,
    pub time: String,
    pub who: Option<String>,
    pub text: String,
}

/// Итог вычитки одной встречи.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PolishStats {
    pub lines: usize,
    pub changed: usize,
    pub removed: usize,
    /// Правки, которые модель предложила, а проверка отклонила (дописала от себя / выбросила смысл).
    pub rejected: usize,
}

pub fn build_prompt(title: &str, people: &str, chunk: &[Line]) -> String {
    let mut s = PROMPT.replace("{title}", title).replace("{people}", people);
    for l in chunk {
        match &l.who {
            Some(who) => s.push_str(&format!("[{}] {} {}: {}\n", l.n, l.time, who, l.text)),
            None => s.push_str(&format!("[{}] {} {}\n", l.n, l.time, l.text)),
        }
    }
    s
}

/// Правки из ответа модели: номер строки -> новый текст (пустой - убрать строку).
/// Берём только строки-JSON между метками; без меток - пусто (ответ не в формате - ничего не меняем).
pub fn parse_answer(answer: &str) -> Vec<(usize, String)> {
    let open = answer.find("<<<ВЫЧИТКА").map(|i| i + "<<<ВЫЧИТКА".len());
    let close = answer.rfind("ВЫЧИТКА>>>");
    // Ответ без начальной метки (длинный ответ доходит обрезанным сверху) - берём то, что дошло до конечной.
    let (start, end) = match (open, close) {
        (Some(o), Some(c)) if c >= o => (o, c),
        (Some(o), _) => (o, answer.len()),
        (None, Some(c)) => (0, c),
        (None, None) => return Vec::new(),
    };
    answer[start..end]
        .lines()
        .filter_map(|raw| {
            let raw = raw.trim().trim_end_matches(',');
            if !raw.starts_with('{') {
                return None;
            }
            let v: serde_json::Value = serde_json::from_str(raw).ok()?;
            let n = v.get("n")?.as_u64()? as usize;
            let text = v.get("text")?.as_str()?.trim().to_string();
            Some((n, text))
        })
        .collect()
}

/// Слова реплики без мусора: однобуквенные обрывки выкинуты, повторы подряд схлопнуты («ф ф ф ф функциональности»
/// -> «функциональности»). По ним меряем, сколько смысла было в исходной реплике.
fn meaningful_words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2) {
        let w = w.to_lowercase();
        if out.last() != Some(&w) {
            out.push(w);
        }
    }
    out
}

/// Слова-паразиты и служебные слова: их вычитка вправе убирать, в проверке «смысл сохранён» они не считаются.
const LIGHT_WORDS: &[&str] = &[
    "ну", "вот", "как", "бы", "типа", "короче", "значит", "это", "самое", "так", "сказать", "вообще", "просто",
    "собственно", "там", "тут", "такой", "такая", "такие", "такое", "как-бы", "блин", "окей", "ладно", "давай",
    "смотри", "слушай", "понимаешь", "знаешь", "скажем", "условно", "грубо", "говоря", "общем", "кстати", "да",
    // «то есть» - самый частый паразит.
    "есть",
];

/// Содержательные слова реплики: от 4 букв, не паразиты, повторы подряд схлопнуты.
fn content_words(text: &str) -> Vec<String> {
    meaningful_words(text)
        .into_iter()
        .filter(|w| w.chars().count() >= 4 && !LIGHT_WORDS.contains(&w.as_str()))
        .collect()
}

/// Есть ли слово в новом тексте с точностью до окончания (первые 5 букв; «вендорам» = «вендоров»).
fn kept(word: &str, new_words: &[String]) -> bool {
    let stem: String = word.chars().take(5).collect();
    new_words.iter().any(|w| w.starts_with(&stem) || stem.starts_with(w.as_str()))
}

/// Число словами («двадцать», «третьего», «пятьсот») - вычитка вправе записать его цифрами.
fn is_number_word(word: &str) -> bool {
    const STEMS: &[&str] = &[
        "один", "одно", "два", "двух", "две", "три", "трёх", "трех", "четыр", "пят", "шест", "сем", "восем", "девят",
        "десят", "одиннадц", "двенадц", "тринадц", "четырнадц", "пятнадц", "шестнадц", "семнадц", "восемнадц",
        "девятнадц", "двадцат", "тридцат", "сорок", "пятьдес", "шестьдес", "семьдес", "восемьдес", "девяност",
        "сто", "двест", "трист", "четырест", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот", "тысяч",
        "миллион", "миллиард", "перв", "втор", "трет", "четвёрт", "четверт", "полтор",
    ];
    STEMS.iter().any(|s| word.starts_with(s))
}

/// Можно ли принять правку. Модель просили ничего не дописывать и не выбрасывать смысл; проверяем:
/// - удалить строку можно, только если в ней было мало смысла (до 6 осмысленных слов);
/// - новый текст не длиннее исходного в 1,5 раза (+30 знаков на пунктуацию и замены вроде «апишка» -> API);
/// - из содержательных слов исходной реплики пропасть могут только распознанные с ошибкой: не больше
///   двух и не больше трети (Haiku на пробе 14.10 урезал длинную реплику до первой фразы - такие правки
///   отбрасываем).
pub fn accept(old: &str, new: &str) -> bool {
    accept_in(old, new, true)
}

/// То же с учётом языка встречи: в русской встрече реплику латиницей без кириллицы («If I might.», «Even that uh»)
/// можно убрать как мусор распознавания.
pub fn accept_in(old: &str, new: &str, russian_meeting: bool) -> bool {
    if new.trim().is_empty() {
        // Убрать можно только реплику без смысла: не больше одного содержательного слова («Ииии, ну то есть»).
        // Проба 14.10: «ф ф ф ф функциональности своей страны» модель убрала целиком - так нельзя.
        let latin_junk = russian_meeting
            && !old.chars().any(|c| ('а'..='я').contains(&c.to_lowercase().next().unwrap_or(c)) || c == 'ё' || c == 'Ё')
            && meaningful_words(old).len() <= 4;
        return content_words(old).len() <= 1 || latin_junk;
    }
    let (old_len, new_len) = (old.chars().count(), new.chars().count());
    if new_len as f64 > old_len as f64 * 1.5 + 30.0 {
        return false;
    }
    let was = content_words(old);
    let now = meaningful_words(new);
    let has_digits = new.chars().any(|c| c.is_ascii_digit());
    // Новые слова латиницей - термины, записанные как пишутся («Фрэндс энд Фэмили» -> Friends and Family): столько же
    // пропавших русских слов не считаем потерей.
    let mut latin_new = now
        .iter()
        .filter(|w| w.chars().all(|c| c.is_ascii_alphanumeric()) && w.chars().any(|c| c.is_ascii_alphabetic()))
        .filter(|w| !meaningful_words(old).contains(w))
        .count();
    let mut lost = 0usize;
    for w in was.iter().filter(|w| !kept(w, &now)) {
        if has_digits && is_number_word(w) {
            continue;
        }
        if latin_new > 0 && w.chars().any(|c| ('а'..='я').contains(&c) || c == 'ё') {
            latin_new -= 1;
            continue;
        }
        lost += 1;
    }
    lost <= 2.max(was.len() / 3)
}

/// Имя участника для модели: заданное пользователем, иначе «Вы» / «Собеседник N».
fn who(speaker: Option<&str>, names: &HashMap<String, String>) -> Option<String> {
    speaker.and_then(|k| crate::insapp_server::speaker_display_name(k, names))
}

/// Вычитать встречу: правки пишутся в transcripts.polished, отметка - в meetings.polished_at.
/// Ошибка - только если модель не отработала ни одного куска; частичный результат сохраняется.
pub async fn polish_meeting(
    pool: &SqlitePool,
    meeting_id: &str,
    settings: &AiSummarySettings,
) -> Result<PolishStats, String> {
    if !matches!(settings.provider.as_str(), "claude" | "codex") {
        return Err("вычитка умеет только Claude и Codex".to_string());
    }
    let title: String = sqlx::query_as::<_, (String,)>("SELECT title FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|(t,)| t)
        .unwrap_or_else(|| "Встреча".to_string());
    let rows: Vec<(String, String, Option<f64>, Option<String>)> = sqlx::query_as(
        "SELECT id, transcript, audio_start_time, speaker FROM transcripts WHERE meeting_id = ?
         ORDER BY audio_start_time ASC NULLS LAST, timestamp ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("не прочитать расшифровку: {}", e))?;
    if rows.len() < MIN_LINES {
        return Err(format!("встреча слишком короткая ({} реплик)", rows.len()));
    }
    let names: HashMap<String, String> =
        crate::database::repositories::transcript::TranscriptsRepository::get_speaker_names(pool, meeting_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect();

    let lines: Vec<Line> = rows
        .iter()
        .enumerate()
        .map(|(i, (id, text, start, speaker))| {
            let t = start.unwrap_or(0.0).max(0.0) as u64;
            Line {
                n: i + 1,
                id: id.clone(),
                time: format!("{:02}:{:02}", t / 60, t % 60),
                who: who(speaker.as_deref(), &names),
                text: text.trim().to_string(),
            }
        })
        .collect();
    let nonempty: Vec<&Line> = lines.iter().filter(|l| !l.text.is_empty()).collect();
    let russian = crate::audio::fillers::is_russian_context(
        nonempty.iter().filter(|l| crate::audio::fillers::has_cyrillic(&l.text)).count() as u64,
        nonempty.len() as u64,
    );
    let mut people: Vec<String> = lines.iter().filter_map(|l| l.who.clone()).collect();
    people.sort();
    people.dedup();
    let me = crate::insapp_server::get_full_name();
    let people = people
        .into_iter()
        .map(|p| if p == "Вы" && !me.trim().is_empty() { format!("Вы ({})", me.trim()) } else { p })
        .collect::<Vec<_>>()
        .join(", ");

    // Запуск как у резюме: сначала с памятью пользователя, при быстром отказе - без неё.
    let workdir = std::env::temp_dir();
    let base = summary_attempts(
        settings,
        &workdir.to_string_lossy(),
        crate::pty_terminal_commands::summary_memory_workdir(),
    );
    // Claude - с низким усилием: на пробе 14.10 кусок из 200 реплик вычитан за 63 с, с обычным - 11+ минут и обрезанный
    // ответ. Старый CLI без --effort откажет сразу - тогда тот же запуск без него.
    let effort = std::env::var("INSAPP_POLISH_EFFORT").unwrap_or_else(|_| "low".to_string());
    let mut attempts = Vec::new();
    for a in base {
        if settings.provider == "claude" && effort != "default" && !effort.is_empty() {
            let mut with_effort = a.clone();
            with_effort.args.push("--effort".to_string());
            with_effort.args.push(effort.clone());
            attempts.push(with_effort);
        }
        attempts.push(a);
    }
    let chunks: Vec<&[Line]> = lines.chunks(LINES_PER_CALL).collect();
    let mut stats = PolishStats { lines: lines.len(), ..Default::default() };

    // Первый кусок - отдельно: по нему выбираем способ запуска.
    let mut use_attempt = 0usize;
    let first_prompt = build_prompt(&title, &people, chunks[0]);
    let started = std::time::Instant::now();
    let mut first = run_cli_attempt(&attempts[use_attempt], &first_prompt, false).await;
    while let Err(e) = &first {
        let quick = started.elapsed() < std::time::Duration::from_secs(90);
        if !quick || e == AUTH_ERROR || use_attempt + 1 >= attempts.len() {
            break;
        }
        log::warn!("[polish] {}: запуск «{}» не удался ({}) - пробую следующий", meeting_id, attempts[use_attempt].label, e);
        use_attempt += 1;
        first = run_cli_attempt(&attempts[use_attempt], &first_prompt, false).await;
    }
    let first = first.map_err(|e| format!("вычитка не удалась: {}", e))?;

    // Остальные - по три одновременно: часовая встреча вычитывается за время одного куска, а не трёх.
    // Промпты готовим заранее: в поток уходят только номер куска и строка - без ссылок на куски.
    use futures_util::stream::{self, StreamExt};
    let attempt = &attempts[use_attempt];
    let prompts: Vec<(usize, String)> =
        chunks.iter().enumerate().skip(1).map(|(i, c)| (i, build_prompt(&title, &people, c))).collect();
    let rest: Vec<(usize, Result<String, String>)> = stream::iter(prompts)
        .map(|(i, prompt)| async move { (i, run_cli_attempt(attempt, &prompt, false).await) })
        .buffer_unordered(3)
        .collect()
        .await;

    let mut fixes: HashMap<usize, String> = HashMap::new();
    let mut chunks_ok = 0usize;
    for (i, answer) in std::iter::once((0usize, Ok(first))).chain(rest) {
        let chunk = chunks[i];
        let (lo, hi) = (chunk[0].n, chunk[chunk.len() - 1].n);
        let text = match answer {
            Ok(t) => t,
            Err(e) => {
                log::warn!("[polish] {}: кусок {}-{} не вычитан: {}", meeting_id, lo, hi, e);
                continue;
            }
        };
        chunks_ok += 1;
        for (n, new) in parse_answer(&text) {
            if n < lo || n > hi {
                continue;
            }
            let old = &lines[n - 1].text;
            if new == *old {
                continue;
            }
            if accept_in(old, &new, russian) {
                fixes.insert(n, new);
            } else {
                stats.rejected += 1;
                log::info!("[polish] {}: правка строки {} отклонена: «{}» -> «{}»", meeting_id, n, old, new);
            }
        }
    }
    if chunks_ok == 0 {
        return Err("вычитка не удалась".to_string());
    }
    for l in &lines {
        let base = fixes.get(&l.n).cloned().unwrap_or_else(|| l.text.clone());
        let fixed = fix_terms(&base);
        if fixed != base || (fixes.contains_key(&l.n) && base != l.text) {
            fixes.insert(l.n, fixed);
        }
    }
    fixes.retain(|n, new| *new != lines[*n - 1].text);

    // Пишем одной транзакцией: прежняя вычитка стирается, новая ложится целиком.
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE transcripts SET polished = NULL WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    for (n, new) in &fixes {
        sqlx::query("UPDATE transcripts SET polished = ? WHERE id = ?")
            .bind(new)
            .bind(&lines[n - 1].id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if new.is_empty() {
            stats.removed += 1;
        } else {
            stats.changed += 1;
        }
    }
    sqlx::query("UPDATE meetings SET polished_at = ? WHERE id = ?")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    log::info!(
        "[polish] {}: реплик {}, исправлено {}, убрано {}, отклонено {}",
        meeting_id, stats.lines, stats.changed, stats.removed, stats.rejected
    );
    Ok(stats)
}

/// Встречи, которые вычитываются прямо сейчас: повторный запуск (резюме переделали, пока шла вычитка) ждать не будет.
static RUNNING: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Вычитка в фоновом задании резюме - параллельно с резюме: у резюме своя сверка написания по памяти, ждать вычитку
/// ему незачем. true - текст расшифровки изменился (тогда её надо заново отправить на сервер). Открытый экран встречи
/// узнаёт о вычитке событием "transcript-polished" и перечитывает реплики.
pub async fn polish_with_events<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pool: &SqlitePool,
    meeting_id: &str,
    settings: &AiSummarySettings,
) -> bool {
    if !settings.polish {
        return false;
    }
    {
        let Ok(mut running) = RUNNING.lock() else { return false };
        if running.iter().any(|m| m == meeting_id) {
            log::info!("[polish] {}: уже вычитывается - второй запуск пропущен", meeting_id);
            return false;
        }
        running.push(meeting_id.to_string());
    }
    let result = polish_meeting(pool, meeting_id, settings).await;
    if let Ok(mut running) = RUNNING.lock() {
        running.retain(|m| m != meeting_id);
    }
    match result {
        Ok(st) => {
            let _ = app.emit(
                "transcript-polished",
                serde_json::json!({ "meeting_id": meeting_id, "changed": st.changed, "removed": st.removed }),
            );
            st.changed + st.removed > 0
        }
        Err(e) => {
            log::warn!("[polish] {}: вычитка пропущена: {}", meeting_id, e);
            false
        }
    }
}

/// После вычитки расшифровка на сервере устарела - отправляем заново: сервер кладёт новую версию рядом со старой
/// и показывает свежую. Как при обычном сохранении: только при включённой отправке, не для встреч «только
/// локально» (это проверяет upload_meeting_by_id) и не для скачанных с сервера чужих встреч (у них нет папки записи).
pub async fn upload_polished(pool: &SqlitePool, meeting_id: &str) {
    let settings = crate::insapp_server::load_settings(pool).await;
    if !settings.auto_upload || crate::insapp_server::get_api_key().is_empty() {
        return;
    }
    let folder: Option<(Option<String>,)> = sqlx::query_as("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    if folder.and_then(|(f,)| f).map_or(true, |f| f.trim().is_empty()) {
        return;
    }
    match crate::insapp_server_commands::upload_meeting_by_id(pool, meeting_id.to_string()).await {
        Ok(v) => log::info!("[polish] {}: вычитанная расшифровка на сервер: {}", meeting_id, v),
        Err(e) => log::warn!("[polish] {}: вычитанная расшифровка не ушла на сервер: {}", meeting_id, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_json_between_markers() {
        let a = "Вот правки:\n<<<ВЫЧИТКА\n{\"n\": 3, \"text\": \"Функциональности со своей стороны.\"}\n\
                 {\"n\": 7, \"text\": \"\"},\nне json\n{\"n\": \"x\", \"text\": \"y\"}\nВЫЧИТКА>>>\n{\"n\": 9, \"text\": \"за метками\"}";
        assert_eq!(
            parse_answer(a),
            vec![(3, "Функциональности со своей стороны.".to_string()), (7, String::new())]
        );
        assert!(parse_answer("{\"n\": 1, \"text\": \"без меток\"}").is_empty());
    }

    #[test]
    fn accepts_real_fixes() {
        assert!(accept("ф ф ф ф ф ф ф ф ф функциональности своей страны.", "Функциональности со своей стороны."));
        assert!(accept("Мы даём вам опишку и тестовые креды.", "Мы даём вам API и тестовые креды."));
        assert!(accept("Ну вот, как бы, да.", "Да."));
        // Удалить можно только мусор.
        assert!(accept("В В В В В В В", ""));
        assert!(accept("Угу, ну.", ""));
        assert!(accept("Ииии, ну то есть.", ""));
        assert!(accept("If I might.", ""));
        assert!(accept("Even that uh", ""));
        // А реплику с осмысленными словами после мусора - нет (проба 14.10).
        assert!(!accept("ф ф ф ф ф ф ф ф ф функциональности своей страны.", ""));
        // В английской встрече английская реплика - не мусор.
        assert!(!accept_in("Let us agree on the launch date.", "", false));
    }

    #[test]
    fn rejects_cut_sentences() {
        // Проба 14.10 (Haiku): вторая половина реплики выброшена.
        assert!(!accept(
            "Дай дам чуть-чуть контекст по встрече с партнёром. Смотри, мы с ними изначально сами встречались, договаривались. Они хотели с нами запускать витрину.",
            "Дам чуть-чуть контекст по встрече с партнёром."
        ));
        assert!(!accept(
            "Вот, смотри, как вообще глобально работает система отчётов бэкандовой. У нее есть разные модули.",
            "Вот, смотри, как вообще глобально работает система отчётов бэкенда."
        ));
        // А мусор и паразиты убирать можно.
        assert!(accept(
            "Вы обсуждали с С С С С С С С С С Петром, и на встрече была этот вопрос",
            "Вы обсуждали это с Петром, и на встрече был этот вопрос."
        ));
    }

    #[test]
    fn numbers_and_latin_terms_are_not_lost_meaning() {
        // Проба 14.10 (Sonnet): верная правка, которую прежняя проверка отбрасывала.
        assert!(accept(
            "Правильно ли я услышал, что релиз для Фрэндс энд Фэмили не выйдет точно до двадцать третьего числа?",
            "Правильно ли я услышал, что релиз для Friends and Family не выйдет точно до 23 числа?"
        ));
        assert!(accept(
            "что мы на Фрэндс энд Фэмили сможем открыться там, условно говоря, за двадцать дней до готовности к задачу конкурент.",
            "что мы на Friends and Family сможем открыться там, условно говоря, за 20 дней до готовности к задаче конкретно."
        ));
    }

    #[test]
    fn api_slang_becomes_api() {
        assert_eq!(fix_terms("Мы с ними на связи, они нам опишку дали."), "Мы с ними на связи, они нам API дали.");
        assert_eq!(fix_terms("Нам опиху не дают, Апишки нет, партнёрское апи есть"), "Нам API не дают, API нет, партнёрское API есть");
        // Обычные слова не трогаем.
        assert_eq!(fix_terms("описка в договоре, пишите в чат, апельсин"), "описка в договоре, пишите в чат, апельсин");
    }

    #[test]
    fn takes_fixes_from_answer_cut_at_the_top() {
        let a = "{\"n\": 244, \"text\": \"Ой, окей, ладно.\"}\n{\"n\": 250, \"text\": \"\"}\nВЫЧИТКА>>>";
        assert_eq!(parse_answer(a), vec![(244, "Ой, окей, ладно.".to_string()), (250, String::new())]);
    }

    #[test]
    fn rejects_additions_and_lost_meaning() {
        // Дописано от себя.
        assert!(!accept("Да, давай.", "Да, давай созвонимся в четверг и обсудим условия с партнёром подробно."));
        // Длинная мысль выброшена.
        assert!(!accept(
            "Нам потребуется до конца этой недели время, край до начала следующей, чтобы собрать демо-стенд.",
            ""
        ));
        assert!(!accept(
            "Нам потребуется до конца этой недели время, край до начала следующей, чтобы собрать демо-стенд.",
            "Нужна неделя."
        ));
    }

    #[test]
    fn prompt_lists_lines_with_numbers_and_names() {
        let lines = vec![
            Line { n: 1, id: "a".into(), time: "00:05".into(), who: Some("Анна Смирнова".into()), text: "Привет".into() },
            Line { n: 2, id: "b".into(), time: "00:07".into(), who: None, text: "Да".into() },
        ];
        let p = build_prompt("Техничка", "Вы, Анна Смирнова", &lines);
        assert!(p.contains("встречи «Техничка»"));
        assert!(p.contains("Участники встречи: Вы, Анна Смирнова."));
        assert!(p.ends_with("[1] 00:05 Анна Смирнова: Привет\n[2] 00:07 Да\n"));
    }
}
