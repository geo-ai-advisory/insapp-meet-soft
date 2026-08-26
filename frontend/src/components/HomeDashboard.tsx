'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { Sparkles, Check, Cloud, CloudOff } from 'lucide-react';
import { toast } from 'sonner';
import { BulkSummaryDialog } from '@/components/BulkSummaryDialog';

/**
 * Главный экран-дашборд - перенос утверждённого макета «Insapp Pro» (вариант B):
 * - верхняя панель с поиском по встречам,
 * - приветствие по времени суток + подзаголовок + ряд из 3 стат-карточек,
 * - таблица «Недавние встречи» с колонками Встреча / Дата / Статус.
 *
 * ВАЖНО (данные реальные, без выдумки): список встреч из backend содержит только
 * { id, title }. Дату берём из title (формат «Meeting YYYY-MM-DD_HH-MM-SS»), статус
 * сохранённой встречи = «Готово». Колонок «Длит.»/«Тип» в списке нет данных - не показываем.
 *
 * Показывается ТОЛЬКО в простое (не идёт запись). Старт записи - кнопка «Начать запись»
 * в сайдбаре (как в макете B; отдельной центральной карточки записи в варианте B нет).
 *
 * Палитра - дизайн-токены globals.css (bg-card / bg-background / text-foreground /
 * text-muted-foreground / border-border / bg-accent / bg-secondary) -> светлая/тёмная без хардкода серых.
 */

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Дата встречи из её названия. Формат имени: «Meeting 2026-06-16_16-02-04» либо
// «...2026-06-16 16-02-04». Если не распарсилось - null (дату не показываем, не выдумываем).
function parseMeetingDate(m: { title: string; created_at?: string }): Date | null {
  // Сначала реальная дата создания из backend, иначе - из имени-таймстампа.
  if (m.created_at) {
    const d = new Date(m.created_at);
    if (!isNaN(d.getTime())) return d;
  }
  const t = m.title.match(/(\d{4})-(\d{2})-(\d{2})[_ ](\d{2})-(\d{2})(?:-(\d{2}))?/);
  if (!t) return null;
  const [, y, mo, d, h, mi, s] = t;
  const dt = new Date(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  return isNaN(dt.getTime()) ? null : dt;
}

// «Сегодня, 16:02» / «Вчера, 9:00» / «16 июня».
function formatMeetingDate(dt: Date | null): string {
  if (!dt) return '';
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(dt)) / 86400000);
  const hhmm = `${dt.getHours()}:${String(dt.getMinutes()).padStart(2, '0')}`;
  if (days === 0) return `Сегодня, ${hhmm}`;
  if (days === 1) return `Вчера, ${hhmm}`;
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
}

// Длительность: «42 мин» / «1 ч 05 мин».
function formatDuration(min?: number): string {
  if (!min || min <= 0) return '-';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} ч ${String(m).padStart(2, '0')} мин`;
}

const SearchIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4-4" strokeLinecap="round" />
  </svg>
);

// Документ-иконка строки встречи (как r-icon в макете B)
const DocIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14 3v5h5" />
  </svg>
);

export default function HomeDashboard() {
  const router = useRouter();
  const { meetings, setCurrentMeeting } = useSidebar();

  // Имя пользователя для приветствия (тот же источник, что профиль в sidebar).
  const [firstName, setFirstName] = useState('');
  // Массовое создание резюме: окно выбора встреч.
  const [bulkOpen, setBulkOpen] = useState(false);
  // Какая встреча сейчас в работе по кнопке «Сделать» (в колонке «Резюме»).
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ full_name?: string }>('insapp_get_identity')
      .then((id) => {
        const fn = (id?.full_name || '').trim().split(/\s+/)[0] || '';
        setFirstName(fn);
      })
      .catch(() => {});
  }, []);

  // Тихий досыл на сервер того, что есть локально, но отсутствует в облаке.
  // Нужен для старых встреч: их резюме раньше никуда не уезжали, и по ссылке
  // «Поделиться» показывалось «резюме ещё не сделано». Молча, без всплывашек -
  // пользователю важен результат, а не отчёт о синхронизации.
  useEffect(() => {
    const t = setTimeout(() => {
      invoke<{ summaries_sent?: number; transcripts_sent?: number }>('insapp_sync_pending')
        .then((r) => {
          const n = (r?.summaries_sent || 0) + (r?.transcripts_sent || 0);
          if (n > 0) window.dispatchEvent(new CustomEvent('meetings-refresh'));
        })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  // Создать резюме для одной встречи прямо из списка.
  //
  const makeSummary = async (m: any) => {
    if (busyId) return;
    setBusyId(m.id);

    try {
      await invoke('ai_summary_run_batch', { meetingIds: [m.id] });
    } catch (e: any) {
      setBusyId(null);
      toast.error('Не получилось запустить', {
        description: typeof e === 'string' ? e : (e?.message || 'попробуй ещё раз'),
      });
      return;
    }

    // Ждём появления резюме, опрашивая список встреч.
    //
    // Команда только запускает работу и сразу возвращает управление - само
    // резюме делается в фоне минуту-другую. Опрос надёжнее подписки на события:
    // результат виден по фактическому состоянию встречи, а не по сообщению,
    // которое может не дойти.
    const started = Date.now();
    const LIMIT_MS = 13 * 60 * 1000; // чуть больше таймаута обработки в 12 минут

    const tick = async () => {
      try {
        const list = await invoke<any[]>('api_get_meetings');
        const found = list.find((x) => x.id === m.id);
        if (found?.has_summary) {
          setBusyId(null);
          toast.success('Резюме готово', { description: m.title });
          window.dispatchEvent(new CustomEvent('meetings-refresh'));
          return;
        }
      } catch { /* сеть/база моргнули - просто ждём дальше */ }

      if (Date.now() - started > LIMIT_MS) {
        setBusyId(null);
        toast.error('Резюме не получилось', {
          description: 'Обработка слишком долгая. Попробуй ещё раз.',
        });
        return;
      }
      setTimeout(tick, 4000);
    };
    setTimeout(tick, 4000);
  };

  const allMeetings = useMemo(() => meetings || [], [meetings]);
  const recent = useMemo(() => allMeetings.slice(0, 8), [allMeetings]);
  const totalCount = allMeetings.length;

  // Стат-карточки на РЕАЛЬНЫХ данных (дата из имени встречи).
  const { weekCount, totalMinutes } = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekAgo = startOfToday - 6 * 86400000;
    let week = 0, mins = 0;
    for (const m of allMeetings) {
      mins += (m as any).duration || 0;
      const dt = parseMeetingDate(m);
      if (!dt) continue;
      if (dt.getTime() >= weekAgo) week++;
    }
    return { weekCount: week, totalMinutes: mins };
  }, [allMeetings]);
  // «Расшифровано» в часах (9,2 ч) и подзаголовок «X ч Y мин записей».
  const totalHours = totalMinutes >= 60 ? `${(totalMinutes / 60).toFixed(1).replace('.', ',')} ч` : `${totalMinutes} мин`;
  const totalTimeText = totalMinutes >= 60
    ? `${Math.floor(totalMinutes / 60)} ч ${totalMinutes % 60} мин`
    : `${totalMinutes} мин`;

  const openMeeting = (m: { id: string; title: string }) => {
    console.log('[insapp-meet] home: открытие встречи', m.id);
    setCurrentMeeting(m);
    router.push(`/meeting-details?id=${m.id}`);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-card">
      {/* Верхняя панель с поиском (как b-topbar в макете B) */}
      <div className="flex flex-none items-center gap-3 border-b border-border bg-background px-7 py-3.5">
        <label className="flex max-w-[420px] flex-1 items-center gap-2.5 rounded-[10px] border border-border bg-background/60 px-3 py-2 text-muted-foreground transition-colors focus-within:border-primary focus-within:ring-[3px] focus-within:ring-accent">
          <SearchIcon />
          <input
            type="text"
            placeholder="Поиск по встречам и транскриптам"
            className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="flex-1" />
      </div>

      {/* Тело: скроллится */}
      <div className="flex-1 overflow-y-auto px-7 py-7">
        <div className="mx-auto max-w-4xl">
          {/* Приветствие + 3 стат-карточки */}
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                {greeting()}{firstName ? `, ${firstName}` : ''}
              </h1>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {totalCount > 0
                  ? `${weekCount} ${plural(weekCount, 'встреча', 'встречи', 'встреч')} за эту неделю${totalMinutes > 0 ? ` - ${totalTimeText} записей` : ''}`
                  : 'Начните с первой записи - встречи появятся здесь'}
              </p>
            </div>
            <div className="flex items-end gap-2.5">
              {/* Массовое создание AI-резюме: показывает встречи без резюме,
                  все отмечены; лишние можно снять и скрыть из предложений. */}
              <button
                onClick={() => setBulkOpen(true)}
                className="mr-2 inline-flex items-center gap-2 self-stretch rounded-xl border border-dashed border-border/80 bg-background/40 px-4 text-[12.5px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-secondary hover:text-foreground"
                title="Создать AI-резюме для всех встреч, у которых его ещё нет"
              >
                <Sparkles className="h-[15px] w-[15px] text-primary" />
                Резюме для всех
              </button>
              <StatCard value={totalCount} label="Всего встреч" />
              <StatCard value={weekCount} label="За неделю" />
              <StatCard value={totalHours} label="Расшифровано" />
            </div>
          </div>

          {/* Недавние встречи - таблица с колонками (как b-table в макете B) */}
          <section>
            {recent.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-background/40 px-5 py-12 text-center">
                <p className="text-sm text-muted-foreground">Здесь появятся ваши встречи после первой записи</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                {/* Заголовок таблицы */}
                <div className="flex items-center gap-3 border-b border-border bg-background/50 px-[18px] py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span className="w-[34px] flex-shrink-0" />
                  <span className="min-w-0 flex-1">Встреча</span>
                  <span className="w-[88px] flex-shrink-0">Дата</span>
                  <span className="w-[56px] flex-shrink-0">Длит.</span>
                  <span className="w-[104px] flex-shrink-0">Транскрипт</span>
                  <span className="w-[132px] flex-shrink-0">Резюме</span>
                </div>
                {/* Строки */}
                {recent.map((m) => {
                  const dt = parseMeetingDate(m);
                  return (
                    <div
                      key={m.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openMeeting(m)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMeeting(m); } }}
                      className="group flex w-full cursor-pointer items-center gap-3 border-b border-border px-[18px] py-3 text-left transition-colors last:border-b-0 hover:bg-secondary"
                    >
                      <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px] bg-accent text-accent-foreground">
                        <DocIcon />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">{m.title}</span>
                          {(m as any).meeting_type && (
                            <span className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              (m as any).meeting_type === 'external'
                                ? 'bg-amber-500/10 text-amber-600'
                                : 'bg-[hsl(var(--brand-blue))]/10 text-[hsl(var(--brand-blue))]'
                            }`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${(m as any).meeting_type === 'external' ? 'bg-amber-500' : 'bg-[hsl(var(--brand-blue))]'}`} />
                              {(m as any).meeting_type === 'external' ? 'Внешняя' : 'Внутренняя'}
                            </span>
                          )}
                        </span>
                        {(m as any).preview && (
                          <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{(m as any).preview}</span>
                        )}
                      </span>
                      <span className="w-[88px] flex-shrink-0 text-[13px] text-muted-foreground">{formatMeetingDate(dt)}</span>
                      <span className="w-[56px] flex-shrink-0 text-[13px] tabular-nums text-muted-foreground">{formatDuration((m as any).duration)}</span>

                      {/* Транскрипт: есть ли расшифровка и доехала ли она на сервер */}
                      <span className="w-[104px] flex-shrink-0">
                        <StatusChip ok={!!(m as any).has_transcript} synced={!!(m as any).transcript_synced} okLabel="Есть" />
                      </span>

                      {/* Резюме: либо статус, либо кнопка «сделать прямо отсюда» */}
                      <span className="w-[132px] flex-shrink-0">
                        {(m as any).has_summary ? (
                          <StatusChip ok synced={!!(m as any).summary_synced} okLabel="Есть" />
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); makeSummary(m); }}
                            disabled={busyId === m.id || !(m as any).has_transcript}
                            title={!(m as any).has_transcript ? 'Сначала нужна расшифровка встречи' : 'Создать AI-резюме этой встречи'}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            {busyId === m.id ? (
                              <>
                                <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-primary border-t-transparent" />
                                Делаю...
                              </>
                            ) : (
                              <>
                                <Sparkles className="h-3 w-3 text-primary" />
                                Сделать
                              </>
                            )}
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Массовое создание резюме: выбор встреч, запуск и видимый ход работы.
          Окно само показывает прогресс - закрывать его при запуске не нужно. */}
      <BulkSummaryDialog open={bulkOpen} onClose={() => setBulkOpen(false)} />
    </div>
  );
}

/**
 * Индикатор статуса для колонок «Транскрипт» и «Резюме».
 *
 * Показывает две разные вещи одним чипом: есть ли документ вообще и уехал ли он
 * на сервер. Облачко серое = документ пока только на этом компьютере, по ссылке
 * «Поделиться» его не увидят.
 */
function StatusChip({ ok, synced, okLabel }: { ok: boolean; synced: boolean; okLabel: string }) {
  if (!ok) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] font-medium text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        Нет
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11.5px] font-medium text-emerald-600"
      title={synced ? 'Есть и загружено на сервер' : 'Есть, но пока только на этом компьютере'}
    >
      <Check className="h-3 w-3" />
      {okLabel}
      {synced ? (
        <Cloud className="h-3 w-3 text-emerald-600/80" />
      ) : (
        <CloudOff className="h-3 w-3 text-muted-foreground/60" />
      )}
    </span>
  );
}

// Стат-карточка (3 шт в ряд, как b-stat в макете B).
function StatCard({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="min-w-[96px] rounded-xl border border-border bg-card px-4 py-2.5">
      <div className="text-xl font-bold tracking-tight text-foreground tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground">{label}</div>
    </div>
  );
}

// Русская плюрализация (1 встреча / 2 встречи / 5 встреч).
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
