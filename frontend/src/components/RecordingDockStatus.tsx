'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface RecState {
  is_recording: boolean;
  is_paused: boolean;
  active_duration: number | null;
}

/**
 * Компактная индикация записи для нижнего дока (компоновка «нижний док»):
 * статус «Идёт запись/Пауза» + бегущий таймер + уровень-волна.
 * Таймер/пауза читаются из get_recording_state (источник истины — бэкенд записи),
 * как раньше делал RecordingHero.
 */
export default function RecordingDockStatus() {
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);

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

  const mmss = (sec: number) =>
    `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-2.5">
      {paused && (
        <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-600 whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />Пауза
        </span>
      )}
      <span className="text-[17px] font-bold tabular-nums text-foreground leading-none">{mmss(elapsed)}</span>
      <span className="flex items-end gap-[2.5px] h-5" aria-hidden>
        {Array.from({ length: 9 }).map((_, i) => (
          <span
            key={i}
            className={`w-[3px] rounded-full ${paused ? 'bg-amber-500/60' : 'bg-destructive wave-bar'}`}
            style={{ height: `${30 + ((i * 37) % 60)}%`, animationDelay: `${(i % 6) * 0.11}s` }}
          />
        ))}
      </span>
    </div>
  );
}
