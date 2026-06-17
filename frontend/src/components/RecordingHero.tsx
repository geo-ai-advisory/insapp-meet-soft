'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { Pencil, Mic } from 'lucide-react';

interface RecState {
  is_recording: boolean;
  is_paused: boolean;
  active_duration: number | null;
}

/**
 * Полноэкранная «шапка» экрана идущей записи (перенос из утверждённого макета Insapp Pro):
 * редактируемое название встречи + переключатель «Тип встречи», под разделителем -
 * орб-микрофон с пульсацией, крупный таймер, плашка «Идёт запись»/«Пауза», полоски уровня.
 *
 * Это ВИЗУАЛЬНЫЙ слой поверх рабочей записи: таймер/пауза читаются из get_recording_state,
 * название - из контекста (setMeetingTitle). Тип встречи пока локальный (поле типа появится
 * в данных встречи отдельной задачей - тогда переключатель начнёт сохраняться и уходить в дашборд).
 * Старт/стоп/паузу делает существующий нижний док - его логику не дублируем.
 */
export default function RecordingHero() {
  const { meetingTitle, setMeetingTitle } = useTranscripts();
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [meetingType, setMeetingType] = useState<'in' | 'out'>('in');
  const editRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await invoke<RecState>('get_recording_state');
        if (!alive) return;
        setElapsed(Math.floor(s?.active_duration ?? 0));
        setPaused(!!s?.is_paused);
      } catch (_) { /* во время записи всегда доступно */ }
    };
    poll();
    const id = setInterval(poll, 500);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const mmss = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const accent = paused ? 'text-amber-500' : 'text-destructive';
  const name = meetingTitle && meetingTitle !== '+ New Call' ? meetingTitle : '';

  return (
    <div className="w-full bg-card">
      <div className="mx-auto w-full max-w-[760px] px-7 pt-7">
        {/* Шапка «идентичность встречи»: имя слева, тип справа, снизу разделитель */}
        <div className="flex items-start justify-between gap-6 pb-5 border-b border-border">
          <div className="min-w-0 flex flex-col gap-1.5">
            <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">Текущая запись</span>
            <div className="flex items-center gap-1 group">
              <input
                ref={editRef}
                value={name}
                onChange={(e) => setMeetingTitle(e.target.value)}
                placeholder="Название встречи"
                aria-label="Название встречи"
                className="min-w-0 w-[clamp(160px,30ch,440px)] bg-transparent border border-transparent rounded-lg px-2 py-1 -ml-2 text-[20px] font-bold tracking-[-0.02em] text-foreground placeholder:text-muted-foreground/70 hover:bg-secondary focus:bg-card focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
              />
              <button
                onClick={() => { editRef.current?.focus(); editRef.current?.select(); }}
                aria-label="Переименовать"
                title="Переименовать"
                className="flex-none h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted-foreground/60 opacity-50 group-hover:opacity-100 hover:bg-secondary hover:text-muted-foreground transition"
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-none flex flex-col gap-1.5 items-end">
            <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">Тип встречи</span>
            <div className="inline-flex p-[3px] gap-0.5 rounded-[10px] bg-secondary border border-border">
              {(['in', 'out'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setMeetingType(t)}
                  className={`px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold transition-colors ${
                    meetingType === t
                      ? 'bg-card text-primary shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t === 'in' ? 'Внутренняя' : 'Внешняя'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Сцена записи: орб + таймер + статус + уровень */}
        <div className="flex flex-col items-center pt-8 pb-6">
          <div className="relative w-24 h-24 flex items-center justify-center mb-5">
            {!paused && (
              <>
                <span className="absolute inset-0 rounded-full bg-destructive/15 animate-ping" />
                <span className="absolute inset-0 rounded-full border-2 border-destructive/40" />
              </>
            )}
            <span className={`w-24 h-24 rounded-full flex items-center justify-center ${paused ? 'bg-amber-500/15' : 'bg-destructive/15'}`}>
              <Mic className={`w-9 h-9 ${accent}`} />
            </span>
          </div>

          <div className="text-[46px] font-bold tracking-[-0.02em] text-foreground leading-none tabular-nums">
            {mmss(elapsed)}
          </div>

          <div className={`inline-flex items-center gap-2 mt-3.5 px-3 py-1 rounded-lg text-[12.5px] font-semibold ${paused ? 'text-amber-600 bg-amber-500/10' : 'text-destructive bg-destructive/10'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${paused ? 'bg-amber-500' : 'bg-destructive'}`} />
            {paused ? 'Пауза' : 'Идёт запись'}
          </div>

          <div className="flex items-end gap-[3px] h-7 mt-4" aria-hidden>
            {Array.from({ length: 13 }).map((_, i) => (
              <span
                key={i}
                className={`w-[3px] rounded-full ${paused ? 'bg-amber-500/60' : 'bg-primary'} ${paused ? '' : 'wave-bar'}`}
                style={{ height: `${30 + ((i * 37) % 60)}%`, animationDelay: `${(i % 6) * 0.11}s` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
