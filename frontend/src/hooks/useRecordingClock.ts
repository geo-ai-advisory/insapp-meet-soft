'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface RecState {
  is_recording: boolean;
  is_paused: boolean;
  active_duration: number | null;
  recording_duration?: number | null;
}

export interface RecordingClock {
  /** Секунды записи без пауз - это показывает таймер. */
  elapsed: number;
  /** Секунды с начала записи вместе с паузами - по ним считаем «начало в 11:30». */
  total: number;
  paused: boolean;
}

/**
 * Таймер записи из движка (get_recording_state - источник истины), опрос раз в 0,5 с.
 * Логика перенесена из RecordingDockStatus (нижний док старого экрана записи).
 */
export function useRecordingClock(active: boolean): RecordingClock {
  const [clock, setClock] = useState<RecordingClock>({ elapsed: 0, total: 0, paused: false });

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await invoke<RecState>('get_recording_state');
        if (!alive || !s) return;
        const elapsed = Math.floor(s.active_duration ?? 0);
        const total = Math.floor(s.recording_duration ?? s.active_duration ?? 0);
        const paused = !!s.is_paused;
        setClock((prev) =>
          prev.elapsed === elapsed && prev.total === total && prev.paused === paused ? prev : { elapsed, total, paused },
        );
      } catch { /* во время записи всегда доступно */ }
    };
    poll();
    const id = setInterval(poll, 500);
    return () => { alive = false; clearInterval(id); };
  }, [active]);

  return clock;
}
