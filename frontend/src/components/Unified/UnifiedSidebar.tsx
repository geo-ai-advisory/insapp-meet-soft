'use client';

/**
 * Левая панель главного экрана INmeet (эталон b-air, колонка .side):
 * логотип + облако / настройки / профиль, поиск по встречам и расшифровкам + «Загрузить запись»,
 * «Без резюме N · Резюме для всех», список встреч по дням, галочка «Авто-резюме после встречи»
 * и внизу плашка записи (её рисует UnifiedHome - там живёт логика записи).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Check, Cloud, CloudOff, Search, SlidersHorizontal, Trash2, Upload, X, Loader2 } from 'lucide-react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { UserProfileButton } from '@/components/UserProfileButton';
import { BulkSummaryDialog } from '@/components/BulkSummaryDialog';
import { ConfirmationModal } from '@/components/ConfirmationModel/confirmation-modal';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useSummaryJobs, useElapsed, useAutoSummaryState, humanSummaryError, openClaudeLogin } from '@/hooks/useSummaryJobs';
import Analytics from '@/lib/analytics';
import { dayGroup, formatClock, formatDuration, formatListWhen, parseMeetingDate } from '@/lib/meetingFormat';
import { RecDot, Wave } from './primitives';

export interface MeetingListItem {
  id: string;
  title: string;
  created_at?: string;
  meeting_type?: string;
  duration?: number;
  preview?: string;
  has_transcript?: boolean;
  transcript_synced?: boolean;
  has_summary?: boolean;
  summary_synced?: boolean;
}

export interface LiveListState {
  active: boolean;
  selected: boolean;
  title: string;
  elapsed: number;
  paused: boolean;
}

interface UnifiedSidebarProps {
  meetings: MeetingListItem[];
  selectedId: string | null;
  live: LiveListState;
  onSelect: (id: string) => void;
  onSelectLive: () => void;
  /** Плашка записи внизу (idle - «Начать запись», запись - таймер и «Стоп»). */
  plate: React.ReactNode;
  /** Встреча удалена - главный экран выберет другую. */
  onDeleted?: (id: string) => void;
}

// ---------------------------------------------------------------- шапка: логотип, облако, настройки, профиль
function ServerCloud() {
  const router = useRouter();
  const [st, setSt] = useState<{ on: boolean; ok: boolean | null; url: string; queue: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      invoke<any>('insapp_get_status')
        .then((s) => {
          if (!alive || !s) return;
          setSt({
            on: s.settings?.auto_upload !== false,
            ok: typeof s.server_reachable === 'boolean' ? s.server_reachable : null,
            url: String(s.settings?.server_url || '').replace(/^https?:\/\//, ''),
            queue: Number(s.queue_size || 0),
          });
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 120000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const off = !!st && (!st.on || st.ok === false);
  const title = !st
    ? 'Сервер Insapp'
    : !st.on
      ? 'Отправка на сервер выключена - включите в настройках'
      : st.ok === false
        ? `Сервер недоступен - встречи уедут, когда появится связь${st.queue ? ` (ждут отправки: ${st.queue})` : ''}`
        : `Отправка на сервер включена${st.url ? ` · ${st.url}` : ''}`;

  return (
    <button
      type="button"
      onClick={() => router.push('/settings')}
      className="grid h-9 w-9 flex-none place-items-center rounded-[18px] text-im-mut transition-[background,border-radius] duration-200 hover:bg-im-line active:rounded-[10px]"
      title={title}
      aria-label={`Облако: ${title}`}
    >
      {off ? <CloudOff className="h-5 w-5" /> : <Cloud className="h-5 w-5" />}
    </button>
  );
}

function BrandRow() {
  const router = useRouter();
  return (
    <header className="mb-2.5 ml-1 flex h-10 items-center">
      <span className="inline-flex items-baseline text-[21px] font-bold leading-none tracking-[-0.03em]" aria-label="INmeet">
        <span className="text-im-acc">IN</span>
        <span className="text-im-ink">meet</span>
        <i className="ml-[1.5px] inline-block h-[5px] w-[5px] rounded-full bg-im-rec" aria-hidden="true" />
      </span>
      <span className="ml-[7px] inline-flex h-[18px] items-center rounded-md bg-im-tone px-1.5 text-[10px] font-bold tracking-[0.08em] text-im-on-tone">PRO</span>
      <span className="flex-1" />
      <ServerCloud />
      <button
        type="button"
        onClick={() => router.push('/settings')}
        className="grid h-9 w-9 flex-none place-items-center rounded-[18px] text-im-mut transition-[background,border-radius] duration-200 hover:bg-im-line active:rounded-[10px]"
        title="Настройки"
        aria-label="Настройки"
      >
        <SlidersHorizontal className="h-5 w-5" />
      </button>
      <UserProfileButton collapsed={false} variant="avatar" />
    </header>
  );
}

// ---------------------------------------------------------------- статус резюме в строке
function MakeButton({ selected, starting, onMake, disabled }: { selected: boolean; starting: boolean; onMake: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onMake(); }}
      disabled={starting || disabled}
      title={disabled ? 'Сначала нужна расшифровка встречи' : 'Claude сделает резюме в фоне за 1-3 минуты'}
      className={`relative z-[2] ml-auto inline-flex h-6 items-center rounded-xl px-2.5 text-[12.5px] font-semibold text-im-on-tone transition-[background,border-radius] duration-200 active:rounded-md disabled:opacity-60 ${
        selected ? 'bg-white hover:bg-im-hover' : 'bg-im-tone hover:bg-im-tone-h'
      }`}
    >
      {starting ? 'Запускаю…' : 'Сделать'}
    </button>
  );
}

function PrepStatus({ startedMs }: { startedMs: number }) {
  const elapsed = useElapsed(startedMs);
  // Резюме пишется 1-3 минуты: волна растёт по мере работы, но не доходит до конца.
  const sec = Math.max(0, (Date.now() - startedMs) / 1000);
  const p = Math.min(0.92, Math.max(0.12, sec / 150));
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-medium text-im-ink2" title={`Резюме готовится, идёт ${elapsed}`}>
      <Wave w={34} h={10} p={p} amp={1.8} half={3.4} sw={2.2} className="text-im-data" />
      <time className="im-num">{elapsed}</time>
    </span>
  );
}

function DoneStatus({ selected }: { selected: boolean }) {
  return (
    <span className={`ml-auto inline-flex items-center gap-1.5 text-[12.5px] ${selected ? 'text-im-on-tone2' : 'text-im-mut'}`} title="Резюме готово">
      <i className={`im-sh-pebble grid h-[17px] w-[17px] flex-none place-items-center text-im-on-tone ${selected ? 'bg-white' : 'bg-im-tone'}`}>
        <Check className="h-[11px] w-[11px]" strokeWidth={2.5} />
      </i>
      Резюме
    </span>
  );
}

// ---------------------------------------------------------------- строка встречи
function MeetingRow({
  m, selected, radius, jobStartedMs, starting, snippet, onOpen, onMake, onDelete,
}: {
  m: MeetingListItem;
  selected: boolean;
  radius: string;
  jobStartedMs?: number;
  starting: boolean;
  snippet?: string;
  onOpen: () => void;
  onMake: () => void;
  onDelete: () => void;
}) {
  const dt = parseMeetingDate(m);
  const when = formatListWhen(dt);
  const dur = formatDuration(m.duration);
  const meta = [when, dur].filter(Boolean).join(' · ');
  const running = jobStartedMs !== undefined;

  return (
    <div
      className={`group relative block px-3 pb-2.5 pl-3.5 pt-2.5 transition-[background,border-radius] duration-300 ${
        selected ? 'rounded-[24px] bg-im-tone' : `${radius} bg-im-sheet hover:bg-im-hover`
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 z-[1] rounded-[inherit] focus-visible:outline-none"
        aria-label={m.title}
        aria-current={selected ? 'true' : 'false'}
      />
      <span className={`block truncate pr-0 text-[14.5px] font-semibold leading-5 group-hover:pr-6 ${selected ? 'text-im-on-tone' : 'text-im-ink'}`}>
        {m.title}
      </span>
      <span className={`mt-[3px] flex items-center gap-[5px] whitespace-nowrap text-[12.5px] leading-[18px] ${selected ? 'text-im-on-tone2' : 'text-im-mut'}`}>
        <span className="truncate">{meta}</span>
        {m.transcript_synced && (
          <span title="Расшифровка на сервере" className={selected ? 'text-im-on-tone2' : 'text-im-mut2'}>
            <Cloud className="h-[15px] w-[15px]" />
          </span>
        )}
        {m.has_summary && !running ? (
          <DoneStatus selected={selected} />
        ) : running ? (
          <PrepStatus startedMs={jobStartedMs!} />
        ) : m.has_transcript ? (
          <MakeButton selected={selected} starting={starting} onMake={onMake} />
        ) : null}
      </span>
      {snippet && (
        <span className={`mt-1 line-clamp-2 text-[12px] leading-4 ${selected ? 'text-im-on-tone2' : 'text-im-mut'}`}>
          «{snippet}»
        </span>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute right-2 top-2 z-[2] grid h-6 w-6 place-items-center rounded-full text-im-mut2 opacity-0 transition-opacity hover:bg-white hover:text-im-ink2 focus-visible:opacity-100 group-hover:opacity-100"
        title="Удалить встречу"
        aria-label={`Удалить встречу «${m.title}»`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function LiveRow({ live, radius, onOpen }: { live: LiveListState; radius: string; onOpen: () => void }) {
  return (
    <div className={`group relative block px-3 pb-2.5 pl-3.5 pt-2.5 transition-[background,border-radius] duration-300 ${live.selected ? 'rounded-[24px] bg-im-tone' : `${radius} bg-im-sheet hover:bg-im-hover`} ${live.paused ? 'im-paused' : ''}`}>
      <button type="button" onClick={onOpen} className="absolute inset-0 z-[1] rounded-[inherit]" aria-label={`Идёт запись: ${live.title}`} aria-current={live.selected ? 'true' : 'false'} />
      <span className={`block truncate text-[14.5px] font-semibold leading-5 ${live.selected ? 'text-im-on-tone' : 'text-im-ink'}`}>{live.title}</span>
      <span className={`mt-[3px] flex items-center gap-[5px] whitespace-nowrap text-[12.5px] leading-[18px] ${live.selected ? 'text-im-on-tone2' : 'text-im-mut'}`}>
        <time className="im-num">{formatClock(live.elapsed)}</time>
        <span className="ml-auto inline-flex items-center gap-1.5 font-semibold text-im-on-tone">
          <RecDot />{live.paused ? 'На паузе' : 'Идёт запись'}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- галочка авто-резюме
function AutoSummaryRow() {
  const router = useRouter();
  const a = useAutoSummaryState(() => router.push('/settings'));
  return (
    <div className="mt-1.5 flex-none">
      <button
        type="button"
        role="checkbox"
        aria-checked={a.on}
        onClick={a.toggle}
        title={a.hint}
        className="flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-1 text-left text-[13px] text-im-ink2"
      >
        <span
          className={`grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] border-2 text-white transition-colors ${
            a.on ? (a.warn ? 'border-[#B54708] bg-[#B54708]' : 'border-im-acc bg-im-acc') : 'border-im-mutbg bg-transparent'
          } ${!a.canToggle && !a.on && !a.action ? 'opacity-50' : ''}`}
        >
          {a.saving ? <Loader2 className="h-3 w-3 animate-spin" /> : a.on ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
        </span>
        Авто-резюме после встречи
      </button>
      {a.warn && a.action && (
        <p className="-mt-1 pl-[34px] text-[12px] leading-4 text-[#B54708]">
          Вход в Claude истёк ·{' '}
          <button type="button" onClick={a.action.run} className="font-semibold underline-offset-2 hover:underline" title={a.action.label}>Войти</button>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- вся панель
export function UnifiedSidebar({ meetings, selectedId, live, onSelect, onSelectLive, plate, onDeleted }: UnifiedSidebarProps) {
  const { searchTranscripts, searchResults, isSearching, setMeetings, meetings: ctxMeetings } = useSidebar();
  const { openImportDialog } = useImportDialog();
  const jobs = useSummaryJobs();
  const [startingId, setStartingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [todoIds, setTodoIds] = useState<string[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // «Без резюме N»: сколько встреч ждут резюме (без тех, что пользователь попросил не предлагать,
  // и без тех, чьё резюме уже готовится в фоне - по ним делать ничего не нужно).
  const refreshTodo = useCallback(() => {
    invoke<{ items: { id: string }[] }>('api_get_meetings_without_summary')
      .then((r) => setTodoIds(Array.isArray(r?.items) ? r.items.map((i) => i.id) : []))
      .catch(() => setTodoIds([]));
  }, []);
  useEffect(() => { refreshTodo(); }, [refreshTodo, meetings]);
  const todoCount = todoIds.filter((id) => jobs[id] === undefined).length;

  // Тихий досыл на сервер того, что есть локально, но отсутствует в облаке (как на старой главной):
  // старые резюме раньше никуда не уезжали, и по ссылке «Поделиться» было «резюме ещё не сделано».
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

  // Поиск по названиям и расшифровкам (api_search_transcripts), с небольшой задержкой.
  const onQuery = (v: string) => {
    setQuery(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!v.trim()) return;
    searchTimer.current = setTimeout(() => { searchTranscripts(v); }, 250);
  };

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    const byId = new Map<string, string>();
    for (const r of searchResults || []) byId.set(r.id, r.matchContext);
    return { byId };
  }, [q, searchResults]);

  const visible = useMemo(() => {
    if (!q || !matches) return meetings;
    return meetings.filter((m) => m.title.toLowerCase().includes(q) || matches.byId.has(m.id));
  }, [meetings, q, matches]);

  const groups = useMemo(() => {
    const out: { label: string; items: MeetingListItem[] }[] = [];
    for (const m of visible) {
      const g = dayGroup(parseMeetingDate(m));
      const last = out[out.length - 1];
      if (last && last.label === g) last.items.push(m);
      else out.push({ label: g, items: [m] });
    }
    // Идущая запись - первой в «Сегодня» (если сегодня встреч ещё не было - группа появляется).
    if (live.active && !q && out[0]?.label !== 'Сегодня') out.unshift({ label: 'Сегодня', items: [] });
    return out;
  }, [visible, live.active, q]);

  // Сделать резюме одной встречи прямо из списка - в фоне (как на старой главной).
  const makeSummary = async (m: MeetingListItem) => {
    if (startingId || jobs[m.id] !== undefined) return;
    setStartingId(m.id);
    try {
      await invoke('ai_summary_generate', { meetingId: m.id });
    } catch (e) {
      const err = humanSummaryError(e);
      toast.error('Резюме не запущено', {
        description: err.text,
        duration: err.auth ? 15000 : undefined,
        action: err.auth ? { label: 'Войти в Claude', onClick: () => openClaudeLogin() } : undefined,
      });
    } finally {
      setStartingId(null);
    }
  };

  // Удаление встречи (как в старой боковой панели): подтверждение -> база -> список.
  const confirmDelete = async () => {
    const id = deleteId;
    setDeleteId(null);
    if (!id) return;
    try {
      await invoke('api_delete_meeting', { meetingId: id });
      setMeetings(ctxMeetings.filter((m: any) => m.id !== id));
      Analytics.trackMeetingDeleted(id);
      toast.success('Встреча удалена', { description: 'Все связанные данные удалены' });
      onDeleted?.(id);
      refreshTodo();
    } catch (error) {
      console.error('Failed to delete meeting:', error);
      toast.error('Не удалось удалить встречу', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const radiusFor = (i: number, n: number) => {
    if (n === 1) return 'rounded-[18px]';
    if (i === 0) return 'rounded-[18px_18px_6px_6px]';
    if (i === n - 1) return 'rounded-[6px_6px_18px_18px]';
    return 'rounded-[6px]';
  };

  return (
    <aside className="flex min-h-0 flex-col pb-0 pl-4 pr-2 pt-2.5" aria-label="Встречи">
      <BrandRow />

      {/* Поиск по встречам и расшифровкам + «Загрузить запись» */}
      <div className="flex flex-none gap-1.5">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[20px] bg-white px-3 text-im-mut shadow-[inset_0_0_0_1px_var(--im-line)] focus-within:shadow-[inset_0_0_0_2px_var(--im-acc)]">
          <Search className="h-[18px] w-[18px] flex-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onQuery(''); }}
            placeholder="Поиск по встречам"
            aria-label="Поиск по встречам и расшифровкам"
            className="w-full min-w-0 border-0 bg-transparent p-0 text-[14px] text-im-ink outline-none placeholder:text-im-mut [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" onClick={() => onQuery('')} className="grid h-5 w-5 flex-none place-items-center rounded-full text-im-mut hover:text-im-ink" aria-label="Очистить поиск">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => openImportDialog()}
          className="grid h-10 w-10 flex-none place-items-center rounded-[20px] bg-white text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line)] transition-[background,border-radius] duration-200 hover:bg-im-hover active:rounded-[10px]"
          title="Загрузить запись"
          aria-label="Загрузить запись"
        >
          <Upload className="h-5 w-5" />
        </button>
      </div>

      {/* «Без резюме N · Резюме для всех» */}
      {todoCount > 0 && !q && (
        <div className="mt-2 flex h-[34px] flex-none items-center gap-2 pl-0.5 pr-1 text-[13px] text-im-mutbg">
          <span className="im-sh-cookie12 grid h-[26px] w-[26px] flex-none place-items-center bg-im-butter text-[12.5px] font-bold text-im-on-tone im-num">{todoCount}</span>
          <span>Без резюме</span>
          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            className="ml-auto rounded-md text-[13px] font-semibold text-im-on-tone hover:underline hover:underline-offset-[3px]"
          >
            Резюме для всех
          </button>
        </div>
      )}

      {/* Список встреч по дням */}
      <nav className="im-scroll im-fade-b -mr-2 min-h-0 flex-1 overflow-y-auto pb-[18px] pr-2" aria-label="Список встреч">
        {q && isSearching && visible.length === 0 && (
          <p className="px-1 pt-4 text-[13px] text-im-mut">Ищу…</p>
        )}
        {q && !isSearching && visible.length === 0 && (
          <p className="px-1 pt-4 text-[13px] text-im-mut">Ничего не найдено</p>
        )}
        {!q && meetings.length === 0 && !live.active && (
          <p className="px-1 pt-4 text-[13px] leading-[19px] text-im-mutbg">Пока нет встреч</p>
        )}
        {groups.map((g, gi) => {
          const withLive = gi === 0 && g.label === 'Сегодня' && live.active && !q;
          const n = g.items.length + (withLive ? 1 : 0);
          return (
            <div key={g.label}>
              <div className="px-1 pb-[7px] pt-3.5 text-[12.5px] font-semibold leading-4 text-im-mutbg">{g.label}</div>
              <div className="flex flex-col gap-0.5">
                {withLive && <LiveRow live={live} radius={radiusFor(0, n)} onOpen={onSelectLive} />}
                {g.items.map((m, i) => {
                  const idx = i + (withLive ? 1 : 0);
                  return (
                    <MeetingRow
                      key={m.id}
                      m={m}
                      selected={!live.selected && selectedId === m.id}
                      radius={radiusFor(idx, n)}
                      jobStartedMs={jobs[m.id]}
                      starting={startingId === m.id}
                      snippet={q ? matches?.byId.get(m.id) : undefined}
                      onOpen={() => onSelect(m.id)}
                      onMake={() => makeSummary(m)}
                      onDelete={() => setDeleteId(m.id)}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <AutoSummaryRow />

      {/* Плашка записи */}
      <div className="mt-2 flex-none pb-2">{plate}</div>

      <BulkSummaryDialog
        open={bulkOpen}
        onClose={() => {
          setBulkOpen(false);
          refreshTodo();
          window.dispatchEvent(new CustomEvent('meetings-refresh'));
        }}
      />
      <ConfirmationModal
        isOpen={!!deleteId}
        text="Точно удалить эту встречу? Действие не отменить."
        onConfirm={confirmDelete}
        onCancel={() => setDeleteId(null)}
      />
    </aside>
  );
}
