'use client';

import { useState, useEffect, useCallback } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Download, X, Loader2, RefreshCw, CheckCircle2 } from 'lucide-react';

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'uptodate' | 'error';

/**
 * Авто-обновление через GitHub Releases.
 *
 * При запуске приложения проверяет, есть ли версия новее (updater читает
 * latest.json из GitHub Releases). Если есть - показывает баннер
 * «Доступна новая версия, обновить». Нажатие скачивает и устанавливает
 * обновление, затем перезапускает приложение.
 *
 * Также экспортирует ручную проверку (кнопка в sidebar) через window-событие.
 */
export function UpdateChecker() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showResult, setShowResult] = useState(false); // для ручной проверки - показать "обновлений нет"

  const runCheck = useCallback(async (manual: boolean) => {
    setPhase('checking');
    setError(null);
    if (manual) setShowResult(true);
    try {
      const upd = await check();
      if (upd) {
        setUpdate(upd);
        setPhase('available');
        setDismissed(false);
      } else {
        setPhase('uptodate');
        // Для авто-проверки тихо; для ручной - короткий тост (сам скроется)
        if (manual) setTimeout(() => setShowResult(false), 3000);
      }
    } catch (e) {
      // Нет релизов / нет сети - не мешаем пользователю при авто-проверке
      setPhase('error');
      setError(typeof e === 'string' ? e : (e as any)?.message || 'Ошибка проверки');
      if (!manual) setShowResult(false);
    }
  }, []);

  // Авто-проверка при запуске приложения
  useEffect(() => {
    runCheck(false);
  }, [runCheck]);

  // Ручная проверка по кнопке из sidebar (window-событие)
  useEffect(() => {
    const handler = () => runCheck(true);
    window.addEventListener('insapp-check-update', handler);
    return () => window.removeEventListener('insapp-check-update', handler);
  }, [runCheck]);

  const handleInstall = async () => {
    if (!update) return;
    setPhase('downloading');
    setProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (total > 0) setProgress(Math.round((downloaded / total) * 100));
            break;
          case 'Finished':
            setPhase('installing');
            break;
        }
      });
      // Установлено - перезапускаем приложение на новой версии
      await relaunch();
    } catch (e) {
      setPhase('error');
      setError(typeof e === 'string' ? e : (e as any)?.message || 'Ошибка обновления');
    }
  };

  // Баннер обновления - показываем только когда есть что показать
  const visible =
    (phase === 'available' && !dismissed) ||
    phase === 'downloading' ||
    phase === 'installing' ||
    (showResult && (phase === 'uptodate' || phase === 'checking' || phase === 'error'));

  if (!visible) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[440px] max-w-[90vw]">
      <div className="bg-card rounded-xl shadow-2xl border border-border px-4 py-3">
        {phase === 'available' && (
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-blue-50 text-blue-600 shrink-0">
              <Download className="w-4 h-4 stroke-[1.75]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">
                Доступна новая версия{update?.version ? ` ${update.version}` : ''}
              </div>
              <div className="text-xs text-muted-foreground">Обновить приложение сейчас?</div>
            </div>
            <button
              onClick={handleInstall}
              className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Обновить
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              aria-label="Позже"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {(phase === 'downloading' || phase === 'installing') && (
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">
                {phase === 'downloading' ? `Скачиваю обновление… ${progress}%` : 'Устанавливаю, перезапуск…'}
              </div>
              {phase === 'downloading' && (
                <div className="mt-1.5 h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
          </div>
        )}

        {showResult && phase === 'checking' && (
          <div className="flex items-center gap-2.5">
            <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            <span className="text-sm text-foreground">Проверяю обновления…</span>
          </div>
        )}

        {showResult && phase === 'uptodate' && (
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-green-600" />
            <span className="text-sm text-foreground">У вас последняя версия</span>
          </div>
        )}

        {showResult && phase === 'error' && (
          <div className="flex items-center justify-between gap-2.5">
            <span className="text-sm text-muted-foreground">Не удалось проверить обновления</span>
            <button
              onClick={() => runCheck(true)}
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Ещё раз
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Триггер ручной проверки обновлений (для кнопки в sidebar). */
export function triggerUpdateCheck() {
  window.dispatchEvent(new Event('insapp-check-update'));
}
