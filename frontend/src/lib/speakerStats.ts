/**
 * Кто сколько говорит: секунды речи, доля, последняя фраза по каждому голосу.
 * Работает и с живыми репликами (Transcript), и с репликами сохранённой встречи (сегменты ленты).
 */

export interface SpeakerStat {
  key: string;
  seconds: number;
  share: number;
  count: number;
  lastText: string;
  /** Когда реплика пришла на экран (мс) - для «говорит сейчас» во время записи. 0 - неизвестно. */
  lastAt: number;
  firstIndex: number;
}

interface LineLike {
  id?: string;
  speaker?: string;
  text: string;
  audio_start_time?: number;
  audio_end_time?: number;
  duration?: number;
  timestamp?: number | string;
  endTime?: number;
}

function secondsOf(t: LineLike): number {
  if (typeof t.duration === 'number' && t.duration > 0) return t.duration;
  const start = typeof t.audio_start_time === 'number' ? t.audio_start_time : typeof t.timestamp === 'number' ? t.timestamp : undefined;
  const end = typeof t.audio_end_time === 'number' ? t.audio_end_time : t.endTime;
  if (start !== undefined && end !== undefined && end > start) return end - start;
  // Времени нет - оцениваем по длине фразы (~14 знаков в секунду).
  return Math.max(1, (t.text || '').length / 14);
}

export function computeSpeakerStats(lines: LineLike[]): SpeakerStat[] {
  const map = new Map<string, SpeakerStat>();
  lines.forEach((t, i) => {
    const key = t.speaker;
    if (!key) return;
    const sec = secondsOf(t);
    const arrived = t.id && /^\d{13}-/.test(t.id) ? parseInt(t.id.split('-')[0], 10) : 0;
    const s = map.get(key);
    if (s) {
      s.seconds += sec;
      s.count += 1;
      if ((t.text || '').trim()) s.lastText = t.text.trim();
      s.lastAt = Math.max(s.lastAt, arrived);
    } else {
      map.set(key, { key, seconds: sec, share: 0, count: 1, lastText: (t.text || '').trim(), lastAt: arrived, firstIndex: i });
    }
  });
  const list = Array.from(map.values());
  const total = list.reduce((a, s) => a + s.seconds, 0) || 1;
  list.forEach((s) => { s.share = s.seconds / total; });
  return list;
}

/** Доли в целых процентах, которые в сумме дают 100 (метод наибольших остатков). */
export function roundShares(stats: SpeakerStat[]): Record<string, number> {
  const raw = stats.map((s) => ({ key: s.key, v: s.share * 100 }));
  const base = raw.map((r) => ({ key: r.key, n: Math.floor(r.v), rest: r.v - Math.floor(r.v) }));
  let left = 100 - base.reduce((a, b) => a + b.n, 0);
  if (stats.length === 0) return {};
  [...base].sort((a, b) => b.rest - a.rest).forEach((b) => { if (left > 0) { b.n += 1; left -= 1; } });
  const out: Record<string, number> = {};
  base.forEach((b) => { out[b.key] = b.n; });
  return out;
}

/** «12:04» - минуты:секунды речи. */
export function formatSpeech(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Имя «Вы» у голоса собеседника: его реплики слиты с вашими (например, эхо вашего голоса
 * в звуке собеседников). Такой голос считается и показывается как вы.
 */
export const ME_LABEL = 'Вы';

/**
 * Меньше 3% речи и без имени - почти всегда осколок чужого голоса или шум: в списках участников
 * и «Кто сколько говорит» не показываем (Geo 30.09: «собеседников с долей меньше 3 процентов скрывай»).
 */
export const MIN_VISIBLE_SHARE = 0.03;

/** Голоса одного человека (одинаковая подпись) - одной строкой: секунды и реплики складываются. */
export interface MergedStat extends SpeakerStat {
  /** Все метки голоса этого человека; key - главная (у «Вы» - микрофон). */
  keys: string[];
}

/**
 * Слить голоса по подписи. Geo 30.09: в разговоре один на один речь собеседника местами уходит
 * в других «Собеседников» - такого собеседника называют именем уже известного участника
 * (или «Вы»), и дальше это один человек: одна строка в участниках, одна доля речи.
 */
export function mergeStatsByLabel(stats: SpeakerStat[], labelFor: (key?: string) => string | undefined): MergedStat[] {
  const groups = new Map<string, MergedStat>();
  for (const s of stats) {
    const label = (s.key === 'mic' ? ME_LABEL : labelFor(s.key) || s.key).trim().toLowerCase();
    const g = groups.get(label);
    if (!g) {
      groups.set(label, { ...s, keys: [s.key] });
      continue;
    }
    g.keys.push(s.key);
    g.seconds += s.seconds;
    g.count += s.count;
    g.firstIndex = Math.min(g.firstIndex, s.firstIndex);
    if (s.lastAt >= g.lastAt) {
      g.lastAt = s.lastAt;
      if (s.lastText) g.lastText = s.lastText;
    }
    if (s.key === 'mic') {
      g.key = 'mic';
      g.keys = ['mic', ...g.keys.filter((k) => k !== 'mic')];
    }
  }
  const list = Array.from(groups.values());
  const total = list.reduce((a, s) => a + s.seconds, 0) || 1;
  list.forEach((s) => { s.share = s.seconds / total; });
  return list;
}
