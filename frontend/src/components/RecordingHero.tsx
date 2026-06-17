'use client';

import { useRef, useState } from 'react';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { Pencil } from 'lucide-react';

/**
 * Компактная шапка экрана идущей записи (макет Insapp Pro, компоновка «нижний док»):
 * редактируемое название встречи слева + переключатель «Тип встречи» справа.
 *
 * Индикация записи (орб/таймер/уровень/статус) ПЕРЕЕХАЛА в нижний док (RecordingDockStatus),
 * чтобы лента расшифровки занимала максимум высоты. Старт/стоп/паузу делает нижний док.
 */
export default function RecordingHero() {
  const { meetingTitle, setMeetingTitle } = useTranscripts();
  const [meetingType, setMeetingType] = useState<'in' | 'out'>('in');
  const editRef = useRef<HTMLInputElement | null>(null);

  const name = meetingTitle && meetingTitle !== '+ New Call' ? meetingTitle : '';

  return (
    <div className="w-full bg-card border-b border-border">
      <div className="flex items-start justify-between gap-6 px-7 py-4">
        {/* Название встречи */}
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

        {/* Тип встречи */}
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
    </div>
  );
}
