'use client';

import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react';

/**
 * Окно «Сохранить встречу» - всплывает при нажатии «Стоп» (как #bStopModal в макете
 * Insapp Pro). Пользователь подтверждает/правит название, выбирает тип и видит, куда
 * уйдёт встреча. «Сохранить» запускает реальную остановку+сохранение, «Отмена» -
 * закрывает окно (запись продолжается).
 */
export function SaveMeetingModal({
  open,
  defaultName,
  defaultType = 'in',
  willUpload = true,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  defaultName: string;
  defaultType?: 'in' | 'out';
  willUpload?: boolean;
  onCancel: () => void;
  onConfirm: (name: string, type: 'in' | 'out') => void;
}) {
  const [name, setName] = useState(defaultName);
  const [type, setType] = useState<'in' | 'out'>(defaultType);

  // Сбросить поля при каждом открытии.
  useEffect(() => {
    if (open) {
      setName(defaultName);
      setType(defaultType);
    }
  }, [open, defaultName, defaultType]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4 backdrop-blur-[2px]"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-meeting-title"
        className="w-full max-w-[440px] overflow-hidden rounded-2xl border border-border bg-card shadow-[0_20px_60px_rgba(15,23,42,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Заголовок */}
        <div className="flex items-center gap-3 px-6 pb-3 pt-6">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 4a1 1 0 011-1h9l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1z" />
              <path d="M9 3v5h6" />
              <path d="M9 13h6M9 16h4" />
            </svg>
          </span>
          <h2 id="save-meeting-title" className="text-[17px] font-semibold text-foreground">
            Сохранить встречу
          </h2>
        </div>

        {/* Тело */}
        <div className="space-y-4 px-6 pb-2">
          <div>
            <label htmlFor="save-meeting-name" className="mb-1.5 block text-[12.5px] font-medium text-muted-foreground">
              Название встречи
            </label>
            <input
              id="save-meeting-name"
              type="text"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(name.trim() || defaultName, type); }}
              className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-accent"
              placeholder="Название встречи"
            />
          </div>

          {/* Тип встречи */}
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-foreground">Тип встречи</span>
            <div className="inline-flex rounded-[10px] border border-border bg-background p-0.5">
              {([['in', 'Внутренняя'], ['out', 'Внешняя']] as const).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setType(val)}
                  className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    type === val ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Куда уйдёт */}
          <div className="flex items-center gap-2.5 rounded-xl bg-secondary px-3.5 py-2.5 text-[12.5px] text-muted-foreground">
            <span className="flex-shrink-0 text-muted-foreground">
              {willUpload ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 18a5 5 0 01-.5-10A6 6 0 0118 9a4 4 0 011 7.9" /><path d="M12 11v7M9 15l3 3 3-3" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="8" rx="2" /><rect x="3" y="12" width="18" height="8" rx="2" /><path d="M7 8h.01M7 16h.01" />
                </svg>
              )}
            </span>
            <span>
              {willUpload ? (
                <>После сохранения встреча уйдёт в <b className="font-semibold text-foreground">облако Insapp</b></>
              ) : (
                <>Сохранится <b className="font-semibold text-foreground">локально</b> на вашем Mac</>
              )}
            </span>
          </div>
        </div>

        {/* Кнопки */}
        <div className="flex items-center justify-end gap-2.5 px-6 pb-6 pt-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-border px-4 py-2.5 text-[13.5px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => onConfirm(name.trim() || defaultName, type)}
            className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13.5px] font-semibold text-primary-foreground shadow-[0_4px_12px_rgba(37,99,235,0.3)] transition-[filter,transform] hover:brightness-105 active:scale-[0.98]"
          >
            <Check className="h-4 w-4" strokeWidth={2.6} />
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
