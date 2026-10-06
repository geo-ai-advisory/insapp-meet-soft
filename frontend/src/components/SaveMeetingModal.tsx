'use client';

import React, { useEffect, useState } from 'react';
import { Check, Cloud, CloudOff, Trash2 } from 'lucide-react';
import { useServerAutoUpload, useUploadOptIn } from '@/components/UploadOptInToggle';

/**
 * Окно «Сохранить встречу» - всплывает при нажатии «Стоп» (как #bStopModal в макете
 * Insapp Pro). Пользователь подтверждает/правит название, выбирает тип и видит, куда
 * уйдёт встреча. «Сохранить» запускает реальную остановку+сохранение, «Отмена» -
 * закрывает окно (запись продолжается).
 * «Удалить запись» (Geo 02.10) - остановить и не сохранять: после подтверждения в этом же окне
 * встреча не сохраняется и никуда не уходит, звук и расшифровка удаляются.
 */
export function SaveMeetingModal({
  open,
  defaultName,
  defaultType = 'in',
  onCancel,
  onConfirm,
  onDiscard,
}: {
  open: boolean;
  defaultName: string;
  defaultType?: 'in' | 'out';
  onCancel: () => void;
  onConfirm: (name: string, type: 'in' | 'out') => void;
  onDiscard?: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [type, setType] = useState<'in' | 'out'>(defaultType);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Отправить ли на сервер - тот же выбор, что в шапке записи и в плашке (переключается и здесь).
  const [choice, setUpload] = useUploadOptIn();
  const serverOff = useServerAutoUpload() === false; // выключено в настройках - эта встреча тоже не уйдёт
  const upload = choice && !serverOff;

  // Сбросить поля при каждом открытии.
  useEffect(() => {
    if (open) {
      setName(defaultName);
      setType(defaultType);
      setConfirmDiscard(false);
    }
  }, [open, defaultName, defaultType]);

  if (!open) return null;

  // Подтверждение удаления - в том же окне, в виде общего окна удаления приложения.
  if (confirmDiscard && onDiscard) {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4 backdrop-blur-[2px]"
        onClick={() => setConfirmDiscard(false)}
      >
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="discard-meeting-title"
          className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-card shadow-[0_20px_60px_rgba(15,23,42,0.25)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 px-6 pb-3 pt-6">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <Trash2 className="h-5 w-5" />
            </span>
            <h2 id="discard-meeting-title" className="text-[17px] font-semibold text-foreground">
              Удалить запись?
            </h2>
          </div>
          <p className="px-6 text-[14px] leading-relaxed text-muted-foreground">
            Встреча не сохранится и никуда не уйдёт: звук и расшифровка удалятся.
          </p>
          <div className="flex items-center justify-end gap-2.5 px-6 pb-6 pt-5">
            <button
              type="button"
              autoFocus
              onClick={() => setConfirmDiscard(false)}
              className="rounded-xl border border-border px-4 py-2.5 text-[13.5px] font-medium text-foreground transition-colors hover:bg-secondary"
            >
              Не удалять
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="flex items-center gap-2 rounded-xl bg-destructive px-5 py-2.5 text-[13.5px] font-semibold text-destructive-foreground shadow-sm transition-colors hover:bg-destructive/90 active:scale-[0.98]"
            >
              <Trash2 className="h-4 w-4" />
              Удалить
            </button>
          </div>
        </div>
      </div>
    );
  }

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

          {/* Куда уйдёт - переключается прямо здесь */}
          <button
            type="button"
            role="switch"
            aria-checked={upload}
            onClick={() => setUpload(!choice)}
            disabled={serverOff}
            title={serverOff ? 'Отправка на сервер выключена в настройках' : undefined}
            className="flex w-full items-center gap-2.5 rounded-xl bg-secondary px-3.5 py-2.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-secondary"
          >
            <span className="flex-shrink-0">
              {upload ? <Cloud className="h-[18px] w-[18px]" strokeWidth={1.75} /> : <CloudOff className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            </span>
            <span className="flex-1">
              {upload ? (
                <>После сохранения встреча уйдёт на <b className="font-semibold text-foreground">сервер Insapp</b></>
              ) : (
                <>Сохранится <b className="font-semibold text-foreground">только на этом компьютере</b></>
              )}
            </span>
            <span className={`relative h-5 w-[34px] flex-shrink-0 rounded-full transition-colors ${upload ? 'bg-primary' : 'bg-border'}`} aria-hidden="true">
              <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-card shadow transition-transform duration-150 ${upload ? 'translate-x-[14px]' : 'translate-x-0'}`} />
            </span>
          </button>
        </div>

        {/* Кнопки */}
        <div className="flex items-center justify-end gap-2.5 px-6 pb-6 pt-4">
          {onDiscard && (
            <button
              type="button"
              onClick={() => setConfirmDiscard(true)}
              className="mr-auto flex items-center gap-1.5 rounded-xl px-2 py-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Удалить запись
            </button>
          )}
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
