//! Реплики из одних слов-паразитов («Uh.», «Um», «Mm-hmm», «Э-э»).
//!
//! Распознавание пишет их из шумов, вдохов и «э-э»: с 20.09.2026 это 210 из 6223 строк в встречах Geo,
//! и короткие обрывки заводили лишних «Собеседников» без имени (Geo 30.09: «надо это убивать и не мусорить,
//! по факту это всё один человек говорит, чисто слова-паразиты проскакивают»).
//! Такие реплики не сохраняем, не показываем и не отдаём в резюме. Реплика, где есть хоть одно
//! обычное слово («What uh», «Ага»), остаётся.

const FILLERS: &[&str] = &[
    "uh", "uhh", "um", "umm", "uhm", "hm", "hmm", "hmmm", "mm", "mmm", "mhm", "mmhmm", "uhhuh",
    "ah", "ahh", "eh", "er", "erm", "oh",
    "э", "ээ", "эээ", "эм", "м", "мм", "ммм", "хм",
];

/// Только слова-паразиты (пустая строка - нет).
pub fn is_filler_only(text: &str) -> bool {
    let lower = text.to_lowercase();
    let mut any = false;
    for w in lower.split(|c: char| !(c.is_alphanumeric() || c == '-')) {
        let w = w.trim_matches('-');
        if w.is_empty() {
            continue;
        }
        let joined = w.replace('-', "");
        if !FILLERS.contains(&w) && !FILLERS.contains(&joined.as_str()) {
            return false;
        }
        any = true;
    }
    any
}

/// Короткий обрывок НЕ кириллицей: 1-2 слова без цифр, до 14 букв («In», «Him.», «Yeah.», «The»,
/// «No.», «Thank you.»). В русской встрече это шум или «да / ну / окей», записанные по-английски:
/// с 20.09.2026 таких 793 из 7796 строк Geo (Geo 02.10: «мелкие артефакты, их можно убирать как
/// грязь»). Что это русская встреча, решает вызывающий (см. is_russian_context) - в английской
/// встрече «Yes.» - обычная реплика.
pub fn is_latin_snippet(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().any(|c| is_cyrillic(c) || c.is_ascii_digit()) {
        return false;
    }
    let words = t
        .split(|c: char| !(c.is_alphabetic() || c == '\''))
        .filter(|w| w.chars().any(|c| c.is_alphabetic()))
        .count();
    let letters = t.chars().filter(|c| c.is_alphabetic()).count();
    (1..=2).contains(&words) && letters <= 14
}

fn is_cyrillic(c: char) -> bool {
    matches!(c, '\u{0400}'..='\u{04FF}')
}

/// Встреча по-русски: из `total` непустых реплик кириллица есть в `russian` (не меньше 5 реплик и 60%).
pub fn is_russian_context(russian: u64, total: u64) -> bool {
    total >= 5 && russian * 10 >= total * 6
}

/// Есть ли в тексте кириллица (для подсчёта доли русских реплик).
pub fn has_cyrillic(text: &str) -> bool {
    text.chars().any(is_cyrillic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fillers_from_real_meetings_are_dropped() {
        for t in ["Uh.", "Um", "Mm-hmm.", "Mm.", "Oh.", "Uh-huh.", "Hm.", "Mm-hmm um", "Э-э", "Ммм...", "  Uh,  um. "] {
            assert!(is_filler_only(t), "должно считаться паразитом: {t:?}");
        }
    }

    #[test]
    fn latin_snippets_from_real_meetings() {
        for t in ["In", "Him.", "Yeah.", "No.", "Okay.", "The", "So", "What", "Thank you.", "Sure.", "Interesting.", "It's not", "B."] {
            assert!(is_latin_snippet(t), "обрывок: {t:?}");
        }
        for t in ["Ну да.", "Central Bank, Central Bank.", "Just do that please.", "API 2.0", "Отправь в Telegram", "", "  ", "4"] {
            assert!(!is_latin_snippet(t), "не обрывок: {t:?}");
        }
    }

    #[test]
    fn russian_context_needs_five_lines_and_most_in_cyrillic() {
        assert!(!is_russian_context(4, 4));
        assert!(is_russian_context(5, 5));
        assert!(is_russian_context(87, 100));
        assert!(!is_russian_context(5, 10));
        assert!(has_cyrillic("Окей, давай") && !has_cyrillic("Okay"));
    }

    #[test]
    fn real_phrases_stay() {
        for t in ["What uh", "Ага", "Угу.", "Да.", "Ok.", "Мы уже все? Или еще ждем команду?", "", "   ", "4"] {
            assert!(!is_filler_only(t), "не паразит: {t:?}");
        }
    }
}
