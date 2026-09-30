'use client';

/**
 * Прошедшая встреча на главном экране (эталон b-air/home.html):
 *  - центр: «Внутренняя ▾ · дата · длительность · на сервере», крупное название (правится),
 *    строка ссылок «Скачать .md · Открыть папку · Сделать резюме заново», кнопки «Скопировать для Telegram»
 *    и «Поделиться · без пароля», резюме документом («Править», подпись «Резюме написал Claude Sonnet
 *    в чч:мм») или пустое состояние «Сделать резюме»;
 *  - справа: расшифровка мессенджером с поиском и «Скопировать расшифровку», под ней - «Участники»
 *    (доли речи, минуты, «назвать»), как на экране записи. Geo 30.09: строка участников под названием
 *    занимала много места внутри каждой встречи.
 *
 * Хуки те же, что у старого экрана встречи (app/meeting-details/page-content.tsx):
 * useMeetingData, useSummaryGeneration, useCopyOperations, useMeetingOperations, useTemplates;
 * «Поделиться» и тип встречи - вынесенная из SummaryPanel логика (useShareMeeting, useMeetingType).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  Check, ChevronDown, Cloud, CloudOff, Copy, Download, Folder, Link2, Loader2, Pencil, RotateCw,
  Search, Send, Sparkles, X,
} from 'lucide-react';
import { Summary, TranscriptSegmentData } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useConfig } from '@/contexts/ConfigContext';
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useShareMeeting } from '@/hooks/meeting-details/useShareMeeting';
import { useMeetingType } from '@/hooks/meeting-details/useMeetingType';
import { useMeetingExport } from '@/hooks/meeting-details/useMeetingExport';
import { useSpeakerNames, SpeakerNamesApi } from '@/hooks/useSpeakerNames';
import { useSummaryJobs, useElapsed, humanSummaryError, openClaudeLogin } from '@/hooks/useSummaryJobs';
import { BlockNoteSummaryView } from '@/components/AISummary/BlockNoteSummaryView';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import Analytics from '@/lib/analytics';
import {
  daysAgo, formatDuration, formatKickDate, formatListWhen, hhmm, initialsOf, isFillerOnly, parseMeetingDate, plural,
  shortName, summaryMarkdownOf,
} from '@/lib/meetingFormat';
import { ME_LABEL, MIN_VISIBLE_SHARE, computeSpeakerStats, isAutoLabel, mergeStatsByLabel, roundShares } from '@/lib/speakerStats';
import { SummaryDocument, separateHeaderLines } from './SummaryDocument';
import { Dot } from './primitives';
import { ParticipantsCard, Participant } from './ParticipantsCard';
import type { MeetingListItem } from './UnifiedSidebar';

interface MeetingViewProps {
  meeting: any;
  summaryData: Summary | null;
  listItem?: MeetingListItem;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  onAiSummarySaved?: (markdown: string) => void;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
  onDeleted: (id: string) => void;
}

/** Вся расшифровка для долей речи и поиска (если загружена не целиком - догружаем одним запросом). */
function useAllSegments(meetingId: string, segments: TranscriptSegmentData[], hasMore: boolean, totalCount: number) {
  const [all, setAll] = useState<TranscriptSegmentData[] | null>(null);
  useEffect(() => {
    if (!hasMore || !totalCount) { setAll(null); return; }
    let alive = true;
    invoke<{ transcripts: any[] }>('api_get_meeting_transcripts', { meetingId, limit: totalCount, offset: 0 })
      .then((res) => {
        if (!alive || !res?.transcripts) return;
        setAll(res.transcripts.filter((t: any) => !isFillerOnly(t.text)).map((t: any) => ({
          id: t.id, timestamp: t.audio_start_time ?? 0, endTime: t.audio_end_time, text: t.text,
          confidence: t.confidence, speaker: t.speaker,
        })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [meetingId, hasMore, totalCount]);
  return all ?? segments;
}

// ---------------------------------------------------------------- кнопки шапки
const BTN = 'inline-flex h-10 flex-none items-center gap-2 whitespace-nowrap rounded-[20px] pl-3 pr-4 text-[14px] font-semibold leading-5 transition-[background,border-radius] [transition-duration:250ms] active:rounded-xl disabled:opacity-60';
const BTN_PRIMARY = `${BTN} bg-im-acc text-white hover:bg-im-acc-h`;
const BTN_OUTLINE = `${BTN} bg-white text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line2)] hover:bg-im-hover`;
const QL = 'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg text-[13px] font-medium leading-[18px] text-im-ink2 transition-colors hover:text-im-on-tone disabled:opacity-50 disabled:hover:text-im-ink2';

// ---------------------------------------------------------------- экран встречи
export function MeetingView({
  meeting, summaryData, listItem, shouldAutoGenerate = false, onAutoGenerateComplete, onMeetingUpdated,
  onRefetchTranscripts, onAiSummarySaved, segments = [], hasMore = false, isLoadingMore = false,
  totalCount = 0, loadedCount = 0, onLoadMore, onDeleted,
}: MeetingViewProps) {
  const router = useRouter();
  const { refetchMeetings } = useSidebar();
  const { modelConfig } = useConfig();

  // Хуки старого экрана встречи - логика резюме, названия, копирования не меняется.
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();
  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig,
    isModelConfigLoading: false,
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle,
    setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: () => router.push('/settings'),
  });
  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
    aiSummary: meetingData.aiSummary,
    blockNoteSummaryRef: meetingData.blockNoteSummaryRef,
  });
  const meetingOperations = useMeetingOperations({ meeting });
  const names = useSpeakerNames(meeting.id);
  const { share, sharing, shared } = useShareMeeting(meeting.id);
  const { meetingType, setMeetingType } = useMeetingType(meeting.id, meeting.meeting_type);
  const jobs = useSummaryJobs();
  const jobStarted = jobs[meeting.id];
  const summaryRunning = jobStarted !== undefined;
  const jobElapsed = useElapsed(jobStarted);
  const [startingSummary, setStartingSummary] = useState(false);
  const [confirmRedo, setConfirmRedo] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Analytics.trackPageView('meeting_details');
  }, []);

  // Авто-генерация старым путём, если так настроено (source=recording + isAutoSummary).
  useEffect(() => {
    let cancelled = false;
    const autoGenerate = async () => {
      if (shouldAutoGenerate && meetingData.transcripts.length > 0 && !cancelled) {
        console.log('[insapp-meet] meet: generate-summary (auto)');
        await summaryGeneration.handleGenerateSummary('');
        if (onAutoGenerateComplete && !cancelled) onAutoGenerateComplete();
      }
    };
    autoGenerate();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoGenerate, meeting.id]);

  // Удалить пустую встречу (кнопка в пустой расшифровке).
  const handleDeleteMeeting = async () => {
    try {
      await invoke('api_delete_meeting', { meetingId: meeting.id });
      console.log('[insapp-meet] meet: встреча удалена', meeting.id);
      if (onMeetingUpdated) await onMeetingUpdated();
      await refetchMeetings();
      onDeleted(meeting.id);
    } catch (e) {
      console.error('[insapp-meet] meet: не удалось удалить встречу', e);
      toast.error('Не удалось удалить встречу');
    }
  };

  // Доли речи и участники - по всей расшифровке.
  const allSegments = useAllSegments(meeting.id, segments, hasMore, totalCount);
  const stats = useMemo(() => computeSpeakerStats(allSegments), [allSegments]);
  // «Вы» - инициалы профиля.
  const [meInitials, setMeInitials] = useState('Вы');
  useEffect(() => {
    invoke<{ full_name?: string }>('insapp_get_identity')
      .then((id) => { if (id?.full_name?.trim()) setMeInitials(initialsOf(id.full_name)); })
      .catch(() => {});
  }, []);
  // Голоса с одним именем - один человек (слитые вручную). Безымянные с долей меньше 3% - осколки
  // и шум, в «Участниках» не показываем (Geo 30.09).
  const participants: Participant[] = useMemo(() => {
    const merged = mergeStatsByLabel(stats, names.labelFor);
    const named = (keys: string[]) => keys.some((k) => (!!names.names[k] && !isAutoLabel(names.names[k])) || (k !== 'mic' && !/^system(_\d+)?$/.test(k)));
    const visible = merged.filter((s) => s.key === 'mic' || named(s.keys) || s.share >= MIN_VISIBLE_SHARE);
    const pct = roundShares(visible);
    return [...visible]
      .sort((a, b) => (a.key === 'mic' ? -1 : b.key === 'mic' ? 1 : b.share - a.share))
      .map((s) => {
        const me = s.key === 'mic';
        const label = me ? ME_LABEL : names.labelFor(s.key) || '';
        const unnamed = !me && !named(s.keys);
        const initials = me ? meInitials : unnamed ? '?' : initialsOf(label);
        return {
          key: s.key, keys: s.keys, label, short: me ? 'Вы' : shortName(label), initials, me, unnamed,
          pct: pct[s.key] ?? 0, share: s.share, seconds: s.seconds,
        };
      });
  }, [stats, names, meInitials]);

  const createdAt = parseMeetingDate(meeting);
  const aiSummary = meetingData.aiSummary as any;
  const markdown = summaryMarkdownOf(aiSummary);
  const hasSummary = !!aiSummary && (!!markdown || !!aiSummary.summary_json);
  const hasTranscript = (totalCount || segments.length) > 0;
  const exporter = useMeetingExport({ title: meetingData.meetingTitle, createdAt, markdown });
  const oldFlowLoading = ['processing', 'summarizing', 'regenerating'].includes(summaryGeneration.summaryStatus);

  // Сервер: расшифровка и резюме уехали?
  const tSynced = !!listItem?.transcript_synced;
  const sSynced = !hasSummary || !!listItem?.summary_synced || aiSummary?.sync_status === 'sent';
  const onServer = tSynced && sSynced;

  const sendToServer = async () => {
    if (sending) return;
    setSending(true);
    try {
      let status = '';
      if (!tSynced) {
        const r = await invoke<{ status: string; reason?: string }>('insapp_upload_meeting_by_id', { meetingId: meeting.id });
        status = r?.status || '';
      }
      if (hasSummary && !sSynced) {
        const r = await invoke<{ sync_status: string }>('ai_summary_resend_to_server', { meetingId: meeting.id });
        if (!status || status === 'sent') status = r?.sync_status || status;
      }
      if (status === 'sent' || !status) toast.success('Отправлено на сервер', { description: 'Встреча откроется по ссылке «Поделиться»' });
      else if (status === 'pending') toast.warning('Сервер недоступен', { description: 'Отправим, когда появится связь' });
      else if (status === 'failed') toast.error('Не удалось отправить');
      else if (status === 'disabled') toast.info('Отправка на сервер выключена в настройках');
      window.dispatchEvent(new CustomEvent('meetings-refresh'));
    } catch (e) {
      toast.error('Ошибка отправки', { description: String(e) });
    } finally {
      setSending(false);
    }
  };

  // Резюме в фоне (Claude) - как кнопка AI-резюме старого экрана (AiTerminalLauncher).
  const startSummary = async () => {
    setConfirmRedo(false);
    setStartingSummary(true);
    try {
      await invoke('ai_summary_generate', { meetingId: meeting.id });
      Analytics.trackButtonClick(hasSummary ? 'regenerate_summary' : 'generate_summary', 'meeting_details');
    } catch (e) {
      const err = humanSummaryError(e);
      toast.error('Резюме не запущено', {
        description: err.text,
        duration: err.auth ? 15000 : undefined,
        action: err.auth ? { label: 'Войти в Claude', onClick: () => openClaudeLogin() } : undefined,
      });
    } finally {
      setStartingSummary(false);
    }
  };

  // «Править» -> редактор резюме; «Готово» - сохранить (если были правки).
  const finishEditing = async () => {
    const ref = meetingData.blockNoteSummaryRef.current;
    if (ref?.isDirty) {
      await ref.saveSummary();
      toast.success('Резюме сохранено');
    }
    setEditing(false);
  };
  // Редактор получает шапку протокола отдельными абзацами - иначе после правки она склеится в строку.
  const editorData = useMemo(() => {
    if (!aiSummary || aiSummary.summary_json || typeof aiSummary.markdown !== 'string') return aiSummary;
    return { ...aiSummary, markdown: separateHeaderLines(aiSummary.markdown) };
  }, [aiSummary]);
  const handleSaveSummary = async (data: { markdown?: string; summary_json?: any[] }) => {
    await meetingData.handleSaveSummary(data);
    meetingData.setAiSummary({ ...(meetingData.aiSummary as any), ...data } as any);
  };

  // Название встречи: карандаш -> поле, Enter/уход с поля - сохранить (в базу, список, на сервер).
  const finishTitle = async () => {
    meetingData.setIsEditingTitle(false);
    if (meetingData.isTitleDirty) await meetingData.handleSaveMeetingTitle();
  };

  const syncedAt = aiSummary?.synced_at ? new Date(aiSummary.synced_at) : null;
  const byWhen = syncedAt && !isNaN(syncedAt.getTime())
    ? (daysAgo(syncedAt) === 0 ? ` в ${hhmm(syncedAt)}` : ` ${formatListWhen(syncedAt)} в ${hhmm(syncedAt)}`)
    : '';
  const byline = (
    <p className="m-0 mt-4 flex items-center gap-1.5 text-[12.5px] leading-[18px] text-im-mut">
      <Sparkles className="h-[15px] w-[15px] flex-none text-im-mut2" />
      {markdown ? `Резюме написал Claude Sonnet${byWhen}` : 'AI-резюме'}
      {aiSummary?.summary_json ? ' · с вашими правками' : ''}
    </p>
  );

  const durationText = formatDuration(meeting.duration);
  const speakersCount = participants.length;

  return (
    <>
      {/* ------------------------------------------------------------ центр: встреча и резюме */}
      <main className="flex min-h-0 min-w-0 flex-col rounded-[28px] bg-im-sheet px-8 pt-5" aria-label="Итог встречи">
        {/* Тип · дата · длительность · на сервере */}
        <div className="flex h-9 flex-none items-center gap-2.5 whitespace-nowrap text-[13px] text-im-mut">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-0.5 rounded-lg text-[13px] font-medium text-im-mut transition-colors hover:text-im-on-tone data-[state=open]:text-im-on-tone"
                title="Тип встречи: внутренняя или внешняя"
              >
                {meetingType === 'external' ? 'Внешняя' : 'Внутренняя'}
                <ChevronDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[200px] rounded-[16px] border-0 bg-white p-1.5 shadow-float">
              {(['internal', 'external'] as const).map((k) => (
                <DropdownMenuItem
                  key={k}
                  onSelect={() => setMeetingType(k)}
                  className="flex h-9 cursor-pointer items-center gap-2.5 rounded-[10px] px-3 text-[14px] text-im-ink focus:bg-im-bg"
                >
                  <span className="grid w-4 place-items-center text-im-acc">{meetingType === k && <Check className="h-4 w-4" />}</span>
                  {k === 'internal' ? 'Внутренняя' : 'Внешняя'}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {createdAt && <><Dot /><span>{formatKickDate(createdAt)}</span></>}
          {durationText && <><Dot /><span>{durationText}</span></>}
          {listItem && (
            <>
              <Dot />
              {onServer ? (
                <span className="inline-flex items-center gap-[5px]" title="Расшифровка и резюме на сервере - откроются по ссылке «Поделиться»">
                  <Cloud className="h-4 w-4 text-im-mut2" />на сервере
                </span>
              ) : (
                <span className="inline-flex min-w-0 items-center gap-[5px]">
                  <CloudOff className="h-4 w-4 flex-none text-im-mut2" />
                  <span className="truncate">{tSynced ? 'резюме не на сервере' : 'не на сервере'}</span>
                  <button
                    type="button"
                    onClick={sendToServer}
                    disabled={sending}
                    className="ml-1 inline-flex items-center gap-1 rounded-md font-semibold text-im-on-tone hover:underline hover:underline-offset-[3px] disabled:opacity-60"
                  >
                    {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Отправить
                  </button>
                </span>
              )}
            </>
          )}
        </div>

        {/* Название (правится) */}
        <div className="mt-1.5 flex flex-none items-center gap-1.5">
          {meetingData.isEditingTitle ? (
            <input
              ref={titleInputRef}
              autoFocus
              value={meetingData.meetingTitle}
              onChange={(e) => meetingData.handleTitleChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') finishTitle(); if (e.key === 'Escape') finishTitle(); }}
              onBlur={finishTitle}
              aria-label="Название встречи"
              className="-ml-2 min-w-0 flex-1 rounded-2xl border-[1.5px] border-im-acc bg-white px-2 text-[clamp(28px,2.82vw,36px)] font-bold leading-[1.1667] tracking-[-0.026em] text-im-ink outline-none"
            />
          ) : (
            <>
              <h1 className="im-balance m-0 min-w-0 text-[clamp(28px,2.82vw,36px)] font-bold leading-[1.1667] tracking-[-0.026em] text-im-ink [overflow-wrap:anywhere]">
                {meetingData.meetingTitle}
              </h1>
              <button
                type="button"
                onClick={() => meetingData.setIsEditingTitle(true)}
                className="mt-[3px] grid h-[34px] w-[34px] flex-none place-items-center rounded-[17px] text-im-mut2 transition-[background,border-radius] duration-200 hover:bg-im-tray hover:text-im-ink2 active:rounded-[10px]"
                title="Переименовать"
                aria-label="Переименовать"
              >
                <Pencil className="h-[18px] w-[18px]" />
              </button>
            </>
          )}
        </div>

        {/* Тихие ссылки: файл, папка, резюме заново - сразу под названием */}
        <div className="mt-2 flex flex-none flex-wrap items-center gap-x-5 gap-y-1">
          <button type="button" onClick={exporter.downloadMd} disabled={!hasSummary} className={QL} title={hasSummary ? 'Резюме файлом .md в «Загрузки»' : 'Сначала сделайте резюме'}>
            <Download className="h-4 w-4" />Скачать .md
          </button>
          <button
            type="button"
            onClick={() => { Analytics.trackButtonClick('open_recording_folder', 'meeting_details'); meetingOperations.handleOpenMeetingFolder(); }}
            className={QL}
            title="Открыть папку с записью"
          >
            <Folder className="h-4 w-4" />Открыть папку
          </button>
          {summaryRunning || startingSummary ? (
            <span className={`${QL} cursor-default hover:text-im-ink2`} title="Claude пишет резюме в фоне - можно работать дальше">
              <Loader2 className="h-4 w-4 animate-spin" />{summaryRunning ? `Резюме готовится ${jobElapsed}` : 'Запускаю…'}
            </span>
          ) : hasSummary ? (
            <Popover open={confirmRedo} onOpenChange={setConfirmRedo}>
              <PopoverTrigger asChild>
                <button type="button" className={QL} disabled={!hasTranscript}>
                  <RotateCw className="h-4 w-4" />Сделать резюме заново
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 rounded-[18px] border-0 bg-white p-4 shadow-float">
                <p className="text-[14px] font-semibold text-im-ink">Сделать резюме заново?</p>
                <p className="mt-1 text-[12.5px] leading-[18px] text-im-mut">
                  Текущее резюме заменится новым. Claude напишет его в фоне за 1-3 минуты.
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirmRedo(false)} className="h-9 rounded-[18px] bg-white px-3.5 text-[13.5px] font-semibold text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line2)] hover:bg-im-hover">
                    Отмена
                  </button>
                  <button type="button" onClick={startSummary} className="h-9 rounded-[18px] bg-im-acc px-3.5 text-[13.5px] font-semibold text-white hover:bg-im-acc-h">
                    Сделать заново
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <button type="button" onClick={startSummary} disabled={!hasTranscript} className={QL} title={hasTranscript ? 'Claude сделает резюме в фоне за 1-3 минуты' : 'Сначала нужна расшифровка встречи'}>
              <Sparkles className="h-4 w-4" />Сделать резюме
            </button>
          )}
        </div>

        {/* Кнопки резюме: «Скопировать для Telegram» и «Поделиться · без пароля» - прямо над резюме */}
        <div className="mt-4 flex flex-none flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { Analytics.trackButtonClick('copy_summary_telegram', 'meeting_details'); exporter.copyForTelegram(); }}
            disabled={!hasSummary}
            title={hasSummary ? 'Резюме в формате для Telegram' : 'Сначала сделайте резюме'}
            className={BTN_OUTLINE}
          >
            {exporter.copied ? <Check className="h-5 w-5" /> : <Send className="h-5 w-5" />}
            {exporter.copied ? 'Скопировано' : 'Скопировать для Telegram'}
          </button>
          <button
            type="button"
            onClick={() => { Analytics.trackButtonClick('share_meeting', 'meeting_details'); share(); }}
            disabled={sharing}
            title="Ссылка откроется без пароля"
            className={BTN_PRIMARY}
          >
            {sharing ? <Loader2 className="h-5 w-5 animate-spin" /> : shared ? <Check className="h-5 w-5" /> : <Link2 className="h-5 w-5" />}
            {shared ? 'Ссылка скопирована' : 'Поделиться'}
            {!shared && <span className="-ml-0.5 font-normal">· без пароля</span>}
          </button>
        </div>


        {/* Резюме документом */}
        <div className="im-scroll -mx-8 mt-[18px] flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-im-line px-8 pb-9 pt-6">
          {oldFlowLoading ? (
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <Loader2 className="h-7 w-7 animate-spin text-im-acc" />
              <p className="mt-3 text-[13.5px] text-im-mut">Делаю AI-резюме…</p>
            </div>
          ) : editing && aiSummary ? (
            <div className="flex flex-col">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex-1 text-[13px] font-medium text-im-mut">Правка резюме - изменения сохранятся в этой встрече</span>
                <button type="button" onClick={() => setEditing(false)} className={QL}>
                  <X className="h-4 w-4" />Отмена
                </button>
                <button type="button" onClick={finishEditing} className={`${QL} font-semibold text-im-on-tone`}>
                  <Check className="h-4 w-4" />Готово
                </button>
              </div>
              <div className="im-editor -mx-2 rounded-2xl bg-im-hover px-2 py-3 shadow-[inset_0_0_0_1px_var(--im-line)]">
                <BlockNoteSummaryView
                  ref={meetingData.blockNoteSummaryRef}
                  summaryData={editorData}
                  onSave={handleSaveSummary}
                  onSummaryChange={meetingData.handleSummaryChange}
                  onDirtyChange={meetingData.setIsSummaryDirty}
                  status={summaryGeneration.summaryStatus}
                  error={summaryGeneration.summaryError}
                  onRegenerateSummary={() => summaryGeneration.handleRegenerateSummary()}
                  meeting={{ id: meeting.id, title: meetingData.meetingTitle, created_at: meeting.created_at }}
                />
              </div>
            </div>
          ) : hasSummary || (aiSummary && !markdown) ? (
            <>
              {summaryRunning && (
                <div className="mb-4 flex items-center gap-2 rounded-2xl bg-im-tone px-4 py-2.5 text-[13px] text-im-on-tone">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Claude пишет новое резюме · {jobElapsed} - текущее заменится, когда будет готово
                </div>
              )}
              {markdown ? (
                <SummaryDocument
                  markdown={markdown}
                  byline={byline}
                  headerAction={
                    <button type="button" onClick={() => setEditing(true)} className={`${QL} mt-0 flex-none`}>
                      <Pencil className="h-4 w-4" /><span>Править</span>
                    </button>
                  }
                />
              ) : (
                // Старый формат резюме (разделы с блоками) - показываем как раньше, в редакторе.
                <BlockNoteSummaryView
                  ref={meetingData.blockNoteSummaryRef}
                  summaryData={aiSummary}
                  onSave={handleSaveSummary}
                  onSummaryChange={meetingData.handleSummaryChange}
                  onDirtyChange={meetingData.setIsSummaryDirty}
                  status={summaryGeneration.summaryStatus}
                  error={summaryGeneration.summaryError}
                  onRegenerateSummary={() => summaryGeneration.handleRegenerateSummary()}
                  meeting={{ id: meeting.id, title: meetingData.meetingTitle, created_at: meeting.created_at }}
                />
              )}
            </>
          ) : (
            <SummaryEmpty
              running={summaryRunning}
              elapsed={jobElapsed}
              starting={startingSummary}
              hasTranscript={hasTranscript}
              onStart={startSummary}
            />
          )}
        </div>
      </main>

      {/* ------------------------------------------------------------ справа: расшифровка и участники */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        <TranscriptSheet
          meetingId={meeting.id}
          segments={segments}
          allSegments={allSegments}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          names={names}
          durationText={durationText}
          speakersCount={speakersCount}
          onCopy={() => { Analytics.trackButtonClick('copy_transcript', 'meeting_details'); copyOperations.handleCopyTranscript(names.labelFor); }}
          onDeleteMeeting={handleDeleteMeeting}
        />
        <ParticipantsCard participants={participants} onRename={async (keys, name) => { for (const k of keys) await names.saveName(k, name); }} />
      </div>
    </>
  );
}

/** Резюме ещё нет: «Сделать резюме» или «готовится 0:42» (как SummaryEmptyState старого экрана). */
function SummaryEmpty({
  running, elapsed, starting, hasTranscript, onStart,
}: { running: boolean; elapsed: string; starting: boolean; hasTranscript: boolean; onStart: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <i className="im-sh-cookie12 mb-4 grid h-14 w-14 place-items-center bg-im-butter not-italic text-im-on-tone" aria-hidden="true">
        {running ? <Loader2 className="h-6 w-6 animate-spin" /> : <Sparkles className="h-6 w-6" />}
      </i>
      {running ? (
        <>
          <h3 className="m-0 text-[18px] font-bold leading-6 text-im-ink">Резюме готовится · {elapsed}</h3>
          <p className="mt-1.5 max-w-sm text-[13.5px] leading-5 text-im-mut">
            Claude пишет резюме в фоне, обычно 1-3 минуты. Можно открыть другую встречу - резюме появится само, придёт уведомление.
          </p>
        </>
      ) : hasTranscript ? (
        <>
          <h3 className="m-0 text-[18px] font-bold leading-6 text-im-ink">Резюме ещё не сделано</h3>
          <p className="mt-1.5 max-w-sm text-[13.5px] leading-5 text-im-mut">
            Claude напишет его в фоне за 1-3 минуты - можно продолжать работу.
          </p>
          <button type="button" onClick={onStart} disabled={starting} className={`${BTN_PRIMARY} mt-5`}>
            {starting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
            {starting ? 'Запускаю…' : 'Сделать резюме'}
          </button>
        </>
      ) : (
        <>
          <h3 className="m-0 text-[18px] font-bold leading-6 text-im-ink">Резюме не из чего сделать</h3>
          <p className="mt-1.5 max-w-sm text-[13.5px] leading-5 text-im-mut">В этой встрече нет расшифровки.</p>
        </>
      )}
    </div>
  );
}

/** Правый лист: расшифровка мессенджером, поиск по репликам, «Скопировать расшифровку». */
function TranscriptSheet({
  meetingId, segments, allSegments, hasMore, isLoadingMore, totalCount, loadedCount, onLoadMore, names,
  durationText, speakersCount, onCopy, onDeleteMeeting,
}: {
  meetingId: string;
  segments: TranscriptSegmentData[];
  allSegments: TranscriptSegmentData[];
  hasMore: boolean;
  isLoadingMore: boolean;
  totalCount: number;
  loadedCount: number;
  onLoadMore?: () => void;
  names: SpeakerNamesApi;
  durationText: string;
  speakersCount: number;
  onCopy: () => void;
  onDeleteMeeting: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? allSegments.filter((s) => (s.text || '').toLowerCase().includes(q)) : segments),
    [q, allSegments, segments],
  );
  const sub = [durationText, speakersCount > 0 ? `${speakersCount} ${plural(speakersCount, 'участник', 'участника', 'участников')}` : '']
    .filter(Boolean).join(' · ');
  const iconBtn = 'grid h-9 w-9 flex-none place-items-center rounded-[18px] text-im-mut transition-[background,border-radius] duration-200 hover:bg-im-tray active:rounded-[10px]';

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-[28px] bg-im-sheet pt-3" aria-label="Расшифровка">
      <div className="flex h-9 flex-none items-center gap-2 pb-1 pl-6 pr-3.5">
        {searchOpen ? (
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[18px] bg-im-tray px-3 text-im-mut focus-within:shadow-[inset_0_0_0_2px_var(--im-acc)]">
            <Search className="h-4 w-4 flex-none" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}
              placeholder="Найти в расшифровке"
              aria-label="Найти в расшифровке"
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13.5px] text-im-ink outline-none placeholder:text-im-mut"
            />
            {q && <span className="flex-none text-[12px] text-im-mut im-num">{filtered.length}</span>}
          </label>
        ) : (
          <>
            <b className="text-[15px] font-bold leading-5 text-im-ink">Расшифровка</b>
            {sub && <span className="truncate text-[12.5px] text-im-mut">{sub}</span>}
            <span className="flex-1" />
          </>
        )}
        <button
          type="button"
          onClick={() => { if (searchOpen) { setQuery(''); setSearchOpen(false); } else setSearchOpen(true); }}
          className={iconBtn}
          title={searchOpen ? 'Закрыть поиск' : 'Найти в расшифровке'}
          aria-label={searchOpen ? 'Закрыть поиск' : 'Найти в расшифровке'}
        >
          {searchOpen ? <X className="h-[18px] w-[18px]" /> : <Search className="h-[18px] w-[18px]" />}
        </button>
        <button type="button" onClick={onCopy} className={iconBtn} title="Скопировать расшифровку" aria-label="Скопировать расшифровку" disabled={totalCount === 0 && segments.length === 0}>
          <Copy className="h-[18px] w-[18px]" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <VirtualizedTranscriptView
          segments={filtered}
          isRecording={false}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence
          disableAutoScroll
          hasMore={q ? false : hasMore}
          isLoadingMore={q ? false : isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          meetingId={meetingId}
          speakerNames={names}
          highlight={q}
          emptyText={q ? 'В расшифровке такого нет' : undefined}
          isMeetingView
          onDeleteMeeting={onDeleteMeeting}
          contentClassName="pb-6 pl-4 pr-5 pt-1.5"
        />
      </div>
    </section>
  );
}
