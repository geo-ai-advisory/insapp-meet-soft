"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Loader2, Sparkles, X, Check, EyeOff, AlertCircle, Square , RotateCw } from 'lucide-react';
import { toast } from 'sonner';

interface MeetingRow {
  id: string;
  title: string;
  created_at?: string;
  duration?: number; // минуты
}

/** Что происходит с конкретной встречей в очереди. */
type RowState = 'wait' | 'running' | 'done' | 'error';

/** Ход пакетной работы, как его помнит бэкенд (переживает закрытие окна). */
interface BatchStatus {
  done: number;
  total: number;
  failed: number;
  current_id: string | null;
  current_title: string | null;
  /** Когда взялись за текущую встречу (unix-время, мс). */
  current_started_ms: number | null;
  items: { id: string; title: string; state: string; error?: string | null }[];
  cancelled: boolean;
  finished: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return `Сегодня, ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** Оценка: одно резюме ~1.5 минуты. */
function estimate(count: number): string {
  const mins = Math.round(count * 1.5);
  if (mins < 60) return `~${mins} мин`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `~${h} ч ${m} мин` : `~${h} ч`;
}

/**
 * Окно массового создания AI-резюме.
 *
 * Два режима в одном окне:
 *  1. ВЫБОР - список встреч без резюме, все отмечены; лишние можно снять
 *     и разом пометить «больше не предлагать».
 *  2. РАБОТА - окно НЕ закрывается: видно полосу прогресса, какая встреча
 *     обрабатывается сейчас, что уже готово, что с ошибкой, и кнопку «Остановить».
 */
export function BulkSummaryDialog({ open, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<MeetingRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiding, setHiding] = useState(false);

  // Ход работы
  const [running, setRunning] = useState(false);
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  // Секунды, сколько уже идёт ТЕКУЩАЯ встреча. Без этого пользователь видел
  // застывший «0%» и думал, что всё зависло: первое резюме занимает 1-3 минуты.
  const [elapsed, setElapsed] = useState(0);
  const [finished, setFinished] = useState<null | { done: number; failed: number; cancelled: boolean }>(null);
  // Нажали «Остановить» - ждём, пока очередь свернётся.
  const [stopping, setStopping] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Открытие окна.
  //
  // Два разных случая:
  // 1) Работа уже идёт (окно свернули и открыли снова) - забираем реальный ход
  //    из бэкенда: очередь, что готово, что сейчас делается и сколько уже идёт.
  //    Раньше окно в этом случае грузило список заново и показывало «0%» с
  //    нетронутой очередью, хотя половина встреч была уже сделана.
  // 2) Работы нет - обычный выбор встреч.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setStopping(false);

    invoke<BatchStatus | null>('ai_summary_batch_status')
      .catch(() => null)
      .then(async (st) => {
        if (!alive) return;

        if (st && !st.finished && st.total > 0) {
          // Восстанавливаем ход работы как есть.
          setRows(st.items.map((i) => ({ id: i.id, title: i.title })));
          setStates(Object.fromEntries(st.items.map((i) => [i.id, i.state as RowState])));
          setErrors(Object.fromEntries(st.items.filter((i) => i.error).map((i) => [i.id, i.error!])));
          setSelected(new Set(st.items.map((i) => i.id)));
          setProgress({ done: st.done, total: st.total, failed: st.failed });
          setCurrentId(st.current_id || null);
          // Сколько уже идёт текущая встреча - продолжаем отсчёт, а не с нуля.
          setElapsed(st.current_started_ms ? Math.max(0, Math.round((Date.now() - st.current_started_ms) / 1000)) : 0);
          setRunning(true);
          setFinished(null);
          setLoading(false);
          return;
        }

        // Работы нет - показываем выбор встреч.
        setFinished(null);
        setRunning(false);
        setCurrentId(null);
        try {
          const res = await invoke<{ items: MeetingRow[] }>('api_get_meetings_without_summary');
          if (!alive) return;
          const items = res?.items || [];
          setRows(items);
          setSelected(new Set(items.map((m) => m.id)));
          setStates({});
          setErrors({});
        } catch {
          if (alive) toast.error('Не удалось получить список встреч');
        } finally {
          if (alive) setLoading(false);
        }
      });

    return () => { alive = false; };
  }, [open]);

  // Подписка на ход работы. Живёт всё время, пока окно открыто.
  useEffect(() => {
    if (!open) return;
    const unsubs: UnlistenFn[] = [];
    let alive = true;

    listen<{ meeting_id: string; title: string; done: number; total: number }>('bulk-summary-started', (e) => {
      if (!alive) return;
      const p = e.payload;
      setCurrentId(p.meeting_id);
      setStates((s) => ({ ...s, [p.meeting_id]: 'running' }));
      setProgress((prev) => ({ ...prev, done: p.done, total: p.total }));
      setElapsed(0); // отсчёт по текущей встрече начинается заново
      // Подкручиваем список к текущей встрече, чтобы её было видно.
      const el = document.getElementById(`bulk-row-${p.meeting_id}`);
      el?.scrollIntoView({ block: 'nearest' });
    }).then((u) => unsubs.push(u));

    listen<{ done: number; total: number; meeting_id: string; ok: boolean; error?: string }>('bulk-summary-progress', (e) => {
      if (!alive) return;
      const p = e.payload;
      setStates((s) => ({ ...s, [p.meeting_id]: p.ok ? 'done' : 'error' }));
      if (!p.ok && p.error) setErrors((x) => ({ ...x, [p.meeting_id]: p.error! }));
      setProgress((prev) => ({
        done: p.done,
        total: p.total,
        failed: prev.failed + (p.ok ? 0 : 1),
      }));
    }).then((u) => unsubs.push(u));

    listen<{ total: number; done: number; failed: number; cancelled: boolean }>('bulk-summary-done', (e) => {
      if (!alive) return;
      const p = e.payload;
      setRunning(false);
      setCurrentId(null);
      setStopping(false);
      setFinished({ done: p.done, failed: p.failed, cancelled: !!p.cancelled });
    }).then((u) => unsubs.push(u));

    return () => { alive = false; unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } }); };
  }, [open]);

  // Таймер текущей встречи - чтобы было видно, что работа идёт, а не висит.
  useEffect(() => {
    if (!running || !currentId) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running, currentId]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(rows.map((m) => m.id)));
  }, [allSelected, rows]);

  const unselectedIds = useMemo(
    () => rows.filter((m) => !selected.has(m.id)).map((m) => m.id),
    [rows, selected]
  );

  const hideUnselected = useCallback(async () => {
    if (unselectedIds.length === 0) return;
    setHiding(true);
    try {
      await invoke('api_skip_summary_for_meetings', { meetingIds: unselectedIds });
      setRows((prev) => prev.filter((m) => selected.has(m.id)));
      toast.success(`Скрыто встреч: ${unselectedIds.length}`, {
        description: 'Больше не будут предлагаться для резюме.',
      });
    } catch {
      toast.error('Не удалось скрыть встречи');
    } finally {
      setHiding(false);
    }
  }, [unselectedIds, selected]);

  // Запуск: окно остаётся открытым и показывает ход работы.
  const run = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    // Оставляем в списке только те, что обрабатываем - чтобы очередь была видна как есть.
    setRows((prev) => prev.filter((m) => selected.has(m.id)));
    setStates(Object.fromEntries(ids.map((id) => [id, 'wait' as RowState])));
    setErrors({});
    setProgress({ done: 0, total: ids.length, failed: 0 });
    setFinished(null);
    setRunning(true);
    try {
      await invoke('ai_summary_run_batch', { meetingIds: ids });
    } catch (e: any) {
      setRunning(false);
      const msg = typeof e === 'string' ? e : (e?.message || 'не удалось запустить');
      toast.error('Не получилось запустить создание резюме', { description: msg });
    }
  }, [selected]);

  const cancel = useCallback(async () => {
    // Сразу показываем, что нажатие принято: остановка снимает текущий процесс,
    // но пара секунд на завершение всё равно нужна, и без отклика кнопка
    // выглядела сломанной.
    setStopping(true);
    try {
      await invoke('ai_summary_cancel_batch');
      toast.message('Останавливаю', { description: 'Уже готовые резюме сохранены' });
    } catch {
      setStopping(false);
      toast.error('Не получилось остановить');
    }
  }, []);

  // Повторить только те встречи, которые сорвались.
  //
  // Резюме делает Claude, и по дороге бывает всякое: оборвалась сеть, кончился
  // лимит, зависла обработка длинной встречи. Раньше в таком случае оставалось
  // только закрыть окно и запускать всё заново - включая уже готовые.
  const retryFailed = useCallback(async () => {
    const ids = Object.entries(states)
      .filter(([, st]) => st === 'error')
      .map(([id]) => id);
    if (ids.length === 0) return;

    setStates((s) => {
      const next = { ...s };
      ids.forEach((id) => { next[id] = 'wait'; });
      return next;
    });
    setErrors((x) => {
      const next = { ...x };
      ids.forEach((id) => { delete next[id]; });
      return next;
    });
    setProgress({ done: 0, total: ids.length, failed: 0 });
    setFinished(null);
    setRunning(true);
    try {
      await invoke('ai_summary_run_batch', { meetingIds: ids });
    } catch (e: any) {
      setRunning(false);
      toast.error('Не получилось перезапустить', {
        description: typeof e === 'string' ? e : (e?.message || 'попробуй ещё раз'),
      });
    }
  }, [states]);

  const failedIds = useMemo(
    () => Object.entries(states).filter(([, st]) => st === 'error').map(([id]) => id),
    [states],
  );

  if (!open) return null;

  const count = selected.size;
  const currentTitle = rows.find((m) => m.id === currentId)?.title || '';

  // Прогресс с учётом ТЕКУЩЕЙ встречи.
  //
  // Полоса не должна стоять на месте, пока идёт одна встреча (раньше она
  // прыгала 0 -> 50% -> 100% только по завершённым). Точное время заранее
  // неизвестно: короткая встреча - секунд 40, часовая - несколько минут.
  // Поэтому доля текущей встречи растёт плавно и ЗАМЕДЛЯЯСЬ, никогда не
  // упираясь в потолок: движение видно всегда, а обгона факта не происходит.
  // Насколько продвинулась ТЕКУЩАЯ встреча (0..0.97).
  // Точное время заранее неизвестно: короткая встреча - секунд 40, часовая -
  // несколько минут. Поэтому растёт плавно и замедляясь, не упираясь в потолок.
  const partial = running && currentId ? Math.min(1 - Math.exp(-elapsed / 70), 0.97) : 0;

  // Общий прогресс - с дробной частью, иначе на очереди в 138 встреч одна
  // встреча весит 0.7% и полоса выглядит намертво застывшей на «0%».
  const rawPct = progress.total > 0 ? ((progress.done + partial) / progress.total) * 100 : 0;
  const pct = Math.min(rawPct, 99.5);
  // Показываем десятые доли, пока счёт идёт мелкими шагами.
  const pctText = pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={running ? undefined : onClose}>
      <div
        className="flex max-h-[82vh] w-full max-w-[660px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-foreground">
              {running ? 'Создаю резюме' : finished ? 'Готово' : 'Создать резюме для встреч'}
            </h2>
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
              {running
                ? `${progress.done} из ${progress.total}${currentTitle ? ` · сейчас: ${currentTitle}` : ''}`
                : finished
                  ? `${finished.cancelled ? 'Остановлено. ' : ''}Сделано: ${finished.done - finished.failed}${finished.failed ? `, с ошибками: ${finished.failed}` : ''}`
                  : loading
                    ? 'Смотрю, у каких встреч ещё нет резюме...'
                    : rows.length === 0
                      ? 'У всех встреч уже есть резюме'
                      : `Встреч без резюме: ${rows.length}. Снимите галочки с ненужных.`}
            </p>
          </div>
          {!running && (
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" aria-label="Закрыть">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Полоса прогресса - видна во время работы */}
        {(running || finished) && (
          <div className="border-b border-border bg-background/40 px-5 py-3">
            {/* Общий ход: сделанные встречи сплошной заливкой, текущая - светлее.
                Так на длинной очереди видно и общий прогресс, и что работа идёт
                прямо сейчас (иначе полоса стояла бы на месте минутами). */}
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className={`h-full transition-all duration-500 ${finished?.failed ? 'bg-amber-500' : 'bg-primary'}`}
                style={{ width: `${finished ? 100 : (progress.total > 0 ? (progress.done / progress.total) * 100 : 0)}%` }}
              />
              {!finished && (
                <div
                  className="h-full bg-primary/35 transition-all duration-1000 ease-linear"
                  style={{ width: `${progress.total > 0 ? (partial / progress.total) * 100 : 0}%` }}
                />
              )}
            </div>

            {/* Отдельная полоса текущей встречи: на очереди в сотню встреч
                общий процент почти не двигается, и без неё кажется, что зависло. */}
            {running && currentId && !finished && (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary/70">
                <div
                  className="h-full rounded-full bg-primary/60 transition-all duration-1000 ease-linear"
                  style={{ width: `${Math.round(partial * 100)}%` }}
                />
              </div>
            )}
            <div className="mt-1.5 flex items-center justify-between text-[12px] text-muted-foreground">
              <span className="tabular-nums">
                {finished ? 'Завершено' : `${pctText}%`}
                {running && currentId && <span className="ml-2">идёт {mmss}</span>}
              </span>
              <span>{running ? `осталось ${estimate(Math.max(progress.total - progress.done, 0))}` : ''}</span>
            </div>
          </div>
        )}

        {/* Выбрать все - только до запуска */}
        {!loading && !running && !finished && rows.length > 0 && (
          <div className="flex items-center justify-between border-b border-border bg-background/40 px-5 py-2">
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 accent-primary" />
              Выбрать все
            </label>
            <span className="text-[12px] text-muted-foreground">Выбрано {count} · {estimate(count)}</span>
          </div>
        )}

        {/* Список */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Загружаю...
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Все встречи уже с резюме</div>
          ) : (
            rows.map((m) => {
              const st = states[m.id];
              const on = selected.has(m.id);
              const busy = running || !!finished;
              return (
                <div
                  key={m.id}
                  id={`bulk-row-${m.id}`}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${
                    st === 'running' ? 'bg-primary/10' : busy ? '' : 'cursor-pointer hover:bg-secondary'
                  } ${!busy && !on ? 'opacity-55' : ''}`}
                  onClick={busy ? undefined : () => toggle(m.id)}
                >
                  {/* Слева: галочка до запуска, статус - во время */}
                  <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    {busy ? (
                      st === 'done' ? <Check className="h-4 w-4 text-green-600" />
                      : st === 'error' ? <AlertCircle className="h-4 w-4 text-amber-600" />
                      : st === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-label="идёт" />
                      : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                    ) : (
                      <input type="checkbox" checked={on} readOnly className="h-4 w-4 accent-primary" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">
                    {m.title}
                    {st === 'error' && errors[m.id] && (
                      <span className="ml-2 text-[11px] text-amber-600">{errors[m.id].slice(0, 60)}</span>
                    )}
                  </span>
                  <span className="flex-shrink-0 text-[12px] tabular-nums text-muted-foreground">{formatDate(m.created_at)}</span>
                  <span className="w-[58px] flex-shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                    {m.duration ? `${m.duration} мин` : ''}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Низ */}
        {!loading && rows.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            {running ? (
              <>
                <span className="text-[12px] text-muted-foreground">Окно можно закрыть - работа продолжится</span>
                <div className="flex items-center gap-2">
                  <button onClick={onClose} className="rounded-lg border border-border px-3.5 py-2 text-[13px] text-foreground transition-colors hover:bg-secondary">
                    Свернуть
                  </button>
                  <button
                    onClick={cancel}
                    disabled={stopping}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-[13px] text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    {stopping
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Останавливаю...</>
                      : <><Square className="h-3.5 w-3.5" /> Остановить</>}
                  </button>
                </div>
              </>
            ) : finished ? (
              <>
                <span className="text-[12px] text-muted-foreground">
                  {failedIds.length > 0
                    ? `Не получилось: ${failedIds.length} - можно повторить`
                    : 'Резюме появились во встречах'}
                </span>
                <div className="flex items-center gap-2">
                  {failedIds.length > 0 && (
                    <button
                      onClick={retryFailed}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-secondary"
                      title="Повторить только те встречи, где резюме не получилось"
                    >
                      <RotateCw className="h-3.5 w-3.5" /> Повторить ({failedIds.length})
                    </button>
                  )}
                  <button onClick={onClose} className="rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90">
                    Закрыть
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  onClick={hideUnselected}
                  disabled={unselectedIds.length === 0 || hiding}
                  className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                  title="Убрать встречи со снятой галочкой из будущих предложений"
                >
                  {hiding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <EyeOff className="h-3.5 w-3.5" />}
                  Больше не предлагать{unselectedIds.length > 0 ? ` (${unselectedIds.length})` : ''}
                </button>
                <div className="flex items-center gap-2">
                  <button onClick={onClose} className="rounded-lg border border-border px-3.5 py-2 text-[13px] text-foreground transition-colors hover:bg-secondary">
                    Отмена
                  </button>
                  <button
                    onClick={run}
                    disabled={count === 0}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Создать {count > 0 ? count : ''}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
