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
