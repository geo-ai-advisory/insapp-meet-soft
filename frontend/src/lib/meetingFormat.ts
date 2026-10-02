/**
 * Форматирование для главного экрана INmeet: даты и длительности встреч, таймеры,
 * инициалы участников, текст резюме для Telegram и файла .md.
 * Чистые функции без React - используются списком встреч, шапкой встречи и лентой.
 */

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв.', 'февр.', 'марта', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];

/** Дата встречи: created_at из базы, иначе из имени-таймстампа «Meeting 2026-06-16_16-02-04». */
export function parseMeetingDate(m: { title?: string; created_at?: string }): Date | null {
  if (m.created_at) {
    const d = new Date(m.created_at);
    if (!isNaN(d.getTime())) return d;
  }
  const t = (m.title || '').match(/(\d{4})-(\d{2})-(\d{2})[_ ](\d{2})-(\d{2})(?:-(\d{2}))?/);
  if (!t) return null;
  const [, y, mo, d, h, mi, s] = t;
  const dt = new Date(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  return isNaN(dt.getTime()) ? null : dt;
}

function startOfDay(x: Date): number {
  return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
}

/** Сколько календарных дней назад (0 - сегодня, 1 - вчера). */
export function daysAgo(dt: Date, now: Date = new Date()): number {
  return Math.round((startOfDay(now) - startOfDay(dt)) / 86400000);
}

export function hhmm(dt: Date): string {
  return `${dt.getHours()}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

/** Группа в списке встреч. */
export function dayGroup(dt: Date | null): 'Сегодня' | 'Вчера' | 'Ранее' {
  if (!dt) return 'Ранее';
  const d = daysAgo(dt);
  if (d <= 0) return 'Сегодня';
  if (d === 1) return 'Вчера';
  return 'Ранее';
}

/** Время/дата в строке списка: «11:30» для сегодня и вчера, «25 сент.» для прошлых. */
export function formatListWhen(dt: Date | null): string {
  if (!dt) return '';
  const d = daysAgo(dt);
  if (d <= 1) return hhmm(dt);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return `${dt.getDate()} ${MONTHS_SHORT[dt.getMonth()]}${sameYear ? '' : ` ${dt.getFullYear()}`}`;
}

/** Дата в шапке встречи: «Сегодня, 11:30» / «Вчера, 16:05» / «25 сентября, 14:30». */
export function formatKickDate(dt: Date | null): string {
  if (!dt) return '';
  const d = daysAgo(dt);
  if (d <= 0) return `Сегодня, ${hhmm(dt)}`;
  if (d === 1) return `Вчера, ${hhmm(dt)}`;
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return `${dt.getDate()} ${MONTHS_GEN[dt.getMonth()]}${sameYear ? '' : ` ${dt.getFullYear()}`}, ${hhmm(dt)}`;
}

/** Длительность в минутах: «42 мин» / «1 ч 05 мин». Пусто, если длительности нет. */
export function formatDuration(min?: number | null): string {
  if (!min || min <= 0) return '';
  const m = Math.round(min);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
}

/** Таймер записи: «32:14», больше часа - «1:02:03». */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Время реплики от начала записи: «00:12», «01:04», больше часа - «1:02:03». */
export function formatTs(totalSec?: number): string {
  if (totalSec === undefined || totalSec === null || isNaN(totalSec)) return '';
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** Инициалы: «Анна Смирнова» -> «АС», «Geo M» -> «GM», «Олег» -> «О». */
export function initialsOf(name?: string | null): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/** Короткое имя для строки участников: «Анна Смирнова» -> «Анна»; «Собеседник 3» - как есть. */
export function shortName(label?: string | null): string {
  const l = (label || '').trim();
  if (!l) return '';
  if (/^Собеседник/.test(l)) return l;
  return l.split(/\s+/)[0];
}

/** Русская плюрализация: 1 участник / 2 участника / 5 участников. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Автоматическое имя встречи от движка («Meeting 29_09_26_22_15_03»), которое не стоит показывать как название. */
export function isAutoMeetingTitle(title?: string | null): boolean {
  const t = (title || '').trim();
  return !t || t === '+ New Call' || /^Meeting \d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/.test(t);
}

/** Понятное название по умолчанию: «Встреча 29 сент., 22:15» (коротко - влезает в шапку записи). */
export function defaultMeetingName(dt: Date = new Date()): string {
  return `Встреча ${dt.getDate()} ${MONTHS_SHORT[dt.getMonth()]}, ${hhmm(dt)}`;
}

/** Убрать первый заголовок «# Резюме: ...» - название встречи и так в шапке. */
export function stripTitleH1(markdown: string): string {
  return markdown.replace(/^\s*#\s+[^\n]*\n+/, '');
}

/** Имя файла .md: «Синк с продуктом - 28.09.2026.md» (без запрещённых в именах символов). */
export function meetingFileName(title: string, dt: Date | null): string {
  const safe = (title || 'Встреча').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Встреча';
  const date = dt
    ? `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}`
    : '';
  return `${safe}${date ? ` - ${date}` : ''}.md`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Резюме для Telegram: заголовки и акценты - жирным, пункты - «•», ссылки - «текст (url)».
 * plain - с **жирным** (Telegram Desktop сам делает его жирным при отправке),
 * html - то же с <b>, чтобы при вставке жирный сохранился сразу.
 */
export function summaryToTelegram(markdown: string, title?: string): { plain: string; html: string } {
  const src = stripTitleH1(markdown || '').replace(/\r\n/g, '\n');
  const plainLines: string[] = [];
  const htmlLines: string[] = [];
  let lastBlank = false;

  const inline = (s: string) => {
    // ссылки [текст](url) -> «текст (url)»; `код` -> код; __ / * курсив -> без разметки
    let t = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/`([^`]+)`/g, '$1');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2').replace(/__([^_\n]+)__/g, '$1');
    const plain = t;
    const html = escapeHtml(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    return { plain, html };
  };

  const push = (p: string, h: string) => {
    const blank = p.trim() === '';
    if (blank && (lastBlank || plainLines.length === 0)) return;
    plainLines.push(p);
    htmlLines.push(h);
    lastBlank = blank;
  };

  // Резюме без шапки «🗓 ...» - заголовком идёт название встречи.
  const prependTitle = !!title && !/^\s*[^\n]*🗓/.test(src);
  if (prependTitle) {
    push(`**${title}**`, `<b>${escapeHtml(title!)}</b>`);
    push('', '');
  }

  let titleDone = prependTitle;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    // Первая строка шапки протокола («🗓 О чём встреча») - заголовок, жирным.
    if (!titleDone && line.trim()) {
      titleDone = true;
      if (!/^#{1,6}\s/.test(line) && !/^\s*([-*+•]|\d+[.)])\s/.test(line) && line.length <= 160) {
        const t = line.replace(/\*\*/g, '').trim();
        push(`**${t}**`, `<b>${escapeHtml(t)}</b>`);
        continue;
      }
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[1].replace(/\*\*/g, '').trim();
      if (!lastBlank && plainLines.length) push('', '');
      push(`**${text}**`, `<b>${escapeHtml(text)}</b>`);
      continue;
    }
    const item = /^(\s*)(?:[-*+•])\s+(.*)$/.exec(line);
    if (item) {
      const indent = item[1].length >= 2 ? '   ' : '';
      const { plain, html } = inline(item[2]);
      push(`${indent}• ${plain}`, `${indent}• ${html}`);
      continue;
    }
    const num = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (num) {
      const indent = num[1].length >= 2 ? '   ' : '';
      const { plain, html } = inline(num[3]);
      push(`${indent}${num[2]}. ${plain}`, `${indent}${num[2]}. ${html}`);
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { push('', ''); continue; }
    const { plain, html } = inline(line);
    push(plain, html);
  }
  while (plainLines.length && plainLines[plainLines.length - 1].trim() === '') { plainLines.pop(); htmlLines.pop(); }
  return { plain: plainLines.join('\n'), html: htmlLines.join('<br>') };
}

/** Резюме из данных встречи в markdown (новый формат - markdown; старый - разделы с блоками). */
export function summaryMarkdownOf(summary: any): string {
  if (!summary) return '';
  if (typeof summary.markdown === 'string' && summary.markdown.trim()) return summary.markdown;
  // Старый формат: { key: { title, blocks: [{ content }] } }
  return Object.entries(summary)
    .filter(([key]) => !['markdown', 'summary_json', '_section_order', 'MeetingName'].includes(key))
    .map(([, section]: [string, any]) => {
      if (section && typeof section === 'object' && 'title' in section && Array.isArray(section.blocks)) {
        return `## ${section.title}\n\n${section.blocks.map((b: any) => `- ${b?.content ?? ''}`).join('\n')}`;
      }
      return '';
    })
    .filter((s) => s.trim())
    .join('\n\n');
}

/**
 * Реплика из одних слов-паразитов («Uh.», «Um», «Mm-hmm», «Э-э») - шум распознавания (Geo 30.09:
 * «надо это убивать и не мусорить»). С 0.4.6 такие реплики не сохраняются; в старых встречах - скрываем.
 * Тот же список, что в src-tauri/src/audio/fillers.rs.
 */
const FILLERS = new Set([
  'uh', 'uhh', 'um', 'umm', 'uhm', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'mhm', 'mmhmm', 'uhhuh',
  'ah', 'ahh', 'eh', 'er', 'erm', 'oh',
  'э', 'ээ', 'эээ', 'эм', 'м', 'мм', 'ммм', 'хм',
]);
export function isFillerOnly(text?: string | null): boolean {
  const words = (text || '').toLowerCase().split(/[^\p{L}\p{N}-]+/u).map((w) => w.replace(/^-+|-+$/g, '')).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => FILLERS.has(w) || FILLERS.has(w.replace(/-/g, '')));
}

/**
 * Короткий обрывок не кириллицей: 1-2 слова без цифр, до 14 букв («In», «Him.», «Yeah.», «The», «No.»).
 * В русской встрече это шум или «да / ну / окей», записанные по-английски (Geo 02.10: «мелкие
 * артефакты, их можно убирать как грязь»). Тот же разбор, что в src-tauri/src/audio/fillers.rs.
 */
export function isLatinSnippet(text?: string | null): boolean {
  const t = (text || '').trim();
  if (!t || /[Ѐ-ӿ0-9]/.test(t)) return false;
  const words = t.split(/[^\p{L}']+/u).filter((w) => /\p{L}/u.test(w)).length;
  const letters = (t.match(/\p{L}/gu) || []).length;
  return words >= 1 && words <= 2 && letters <= 14;
}

/** Встреча по-русски: из непустых реплик хотя бы в 60% есть кириллица (и реплик не меньше пяти). */
export function isRussianMeeting(texts: (string | null | undefined)[]): boolean {
  let total = 0;
  let ru = 0;
  for (const t of texts) {
    if (!t || !t.trim()) continue;
    total += 1;
    if (/[Ѐ-ӿ]/.test(t)) ru += 1;
  }
  return total >= 5 && ru * 10 >= total * 6;
}

/** Убрать шум распознавания: слова-паразиты, а в русской встрече - и короткие обрывки латиницей. */
export function withoutNoise<T extends { text?: string | null }>(items: T[]): T[] {
  const russian = isRussianMeeting(items.map((t) => t.text));
  return items.filter((t) => !isFillerOnly(t.text) && !(russian && isLatinSnippet(t.text)));
}
