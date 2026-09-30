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

#[cfg(test)]
mod tests {
    use super::is_filler_only;

    #[test]
    fn fillers_from_real_meetings_are_dropped() {
        for t in ["Uh.", "Um", "Mm-hmm.", "Mm.", "Oh.", "Uh-huh.", "Hm.", "Mm-hmm um", "Э-э", "Ммм...", "  Uh,  um. "] {
            assert!(is_filler_only(t), "должно считаться паразитом: {t:?}");
        }
    }

    #[test]
    fn real_phrases_stay() {
        for t in ["What uh", "Ага", "Угу.", "Да.", "Ok.", "Мы уже все? Или еще ждем команду?", "", "   ", "4"] {
            assert!(!is_filler_only(t), "не паразит: {t:?}");
        }
    }
}
