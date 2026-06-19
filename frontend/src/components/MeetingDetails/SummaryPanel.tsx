"use client";

import { Summary, SummaryResponse, Transcript } from '@/types';
import { EditableTitle } from '@/components/EditableTitle';
import { BlockNoteSummaryView, BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { EmptyStateSummary } from '@/components/EmptyStateSummary';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { SummaryGeneratorButtonGroup } from './SummaryGeneratorButtonGroup';
import { AiTerminalLauncher } from '@/components/AiTerminalLauncher';
import { SummarySyncBadge } from '@/components/SummarySyncBadge';
import { Button } from '@/components/ui/button';
import {
  Save, Copy, Loader2, FolderOpen,
  Calendar, ChevronDown, CheckCircle2, CloudOff,
  ListChecks,
} from 'lucide-react';
import Analytics from '@/lib/analytics';
import { ReactNode, RefObject, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** Вкладки экрана встречи: транскрипт / AI-резюме / задачи. */
export type MeetingTab = 'transcript' | 'summary' | 'tasks';

interface SummaryPanelProps {
  meeting: {
    id: string;
    title: string;
    created_at: string;
    /** Тип встречи: 'internal' | 'external' (по умолчанию 'internal'). */
    meeting_type?: string;
  };
  meetingTitle: string;
  onTitleChange: (title: string) => void;
  isEditingTitle: boolean;
  onStartEditTitle: () => void;
  onFinishEditTitle: () => void;
  isTitleDirty: boolean;
  summaryRef: RefObject<BlockNoteSummaryViewRef>;
  isSaving: boolean;
  onSaveAll: () => Promise<void>;
  onCopySummary: () => Promise<void>;
  onOpenFolder: () => Promise<void>;
  aiSummary: Summary | null;
  summaryStatus: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  transcripts: Transcript[];
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;
  onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
  onGenerateSummary: (customPrompt: string) => Promise<void>;
  onStopGeneration: () => void;
  customPrompt: string;
  summaryResponse: SummaryResponse | null;
  onSaveSummary: (summary: Summary | { markdown?: string; summary_json?: any[] }) => Promise<void>;
  onSummaryChange: (summary: Summary) => void;
  onDirtyChange: (isDirty: boolean) => void;
  summaryError: string | null;
  onRegenerateSummary: () => Promise<void>;
  getSummaryStatusMessage: (status: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error') => string;
  availableTemplates: Array<{ id: string, name: string, description: string }>;
  selectedTemplate: string;
  onTemplateSelect: (templateId: string, templateName: string) => void;
  isModelConfigLoading?: boolean;
  onOpenModelSettings?: (openFn: () => void) => void;
  /** Прямой callback от TerminalPanel когда AI-резюме сохранено -
      даём page.tsx сразу обновить aiSummary, не дожидаясь event'а. */
  onAiSummarySaved?: (markdown: string) => void;

  // --- Вкладки (макет «Insapp Pro», вариант B) ---
  /** Активная вкладка. */
  activeTab: MeetingTab;
  /** Сменить вкладку. */
  onTabChange: (tab: MeetingTab) => void;
  /** Контент вкладки «Транскрипт» (панель транскрипта целиком). */
  transcriptSlot: ReactNode;
  /** Кол-во задач для счётчика на вкладке «Задачи». */
  tasksCount: number;
  /** Список задач (action items) если есть в данных; иначе пусто -> empty-state. */
  tasks?: Array<{ text: string; owner?: string }>;
}

export function SummaryPanel({
  meeting,
  meetingTitle,
  onTitleChange,
  isEditingTitle,
  onStartEditTitle,
  onFinishEditTitle,
  isTitleDirty,
  summaryRef,
  isSaving,
  onSaveAll,
  onCopySummary,
  onOpenFolder,
  aiSummary,
  summaryStatus,
  transcripts,
  modelConfig,
  setModelConfig,
  onSaveModelConfig,
  onGenerateSummary,
  onStopGeneration,
  customPrompt,
  summaryResponse,
  onSaveSummary,
  onSummaryChange,
  onDirtyChange,
  summaryError,
  onRegenerateSummary,
  getSummaryStatusMessage,
  availableTemplates,
  selectedTemplate,
  onTemplateSelect,
  isModelConfigLoading = false,
  onOpenModelSettings,
  onAiSummarySaved,
  activeTab,
  onTabChange,
  transcriptSlot,
  tasksCount,
  tasks,
}: SummaryPanelProps) {
  const isSummaryLoading = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';

  // sync_status и synced_at лежат в JSON summary_processes.result,
  // которое page.tsx распарсивает и кладёт в aiSummary целиком.
  // Тип Summary не описывает эти поля - достаём через as any.
  const summaryAny = aiSummary as any;
  const syncStatus: string | undefined = summaryAny?.sync_status;
  const syncedAt: string | undefined = summaryAny?.synced_at;
  const hasMarkdownSummary = !!summaryAny?.markdown;

  // Тип встречи: внутренняя ('internal') / внешняя ('external').
  // Начальное значение берём из объекта встречи (api_get_meeting -> meeting_type),
  // по умолчанию 'internal'. Переключение сохраняем в backend через api_set_meeting_type.
  const [meetingType, setMeetingType] = useState<'internal' | 'external'>(
    meeting.meeting_type === 'external' ? 'external' : 'internal'
  );
  const isExternal = meetingType === 'external';

  // Синхронизируем локальный тип, если встреча сменилась (другой meeting.id) и
  // backend вернул иной meeting_type.
  useEffect(() => {
    setMeetingType(meeting.meeting_type === 'external' ? 'external' : 'internal');
  }, [meeting.id, meeting.meeting_type]);

  const handleToggleMeetingType = async () => {
    const prev: 'internal' | 'external' = meetingType;
    const next: 'internal' | 'external' = prev === 'external' ? 'internal' : 'external';
    console.log('[insapp-meet] meet: set-type', next);
    setMeetingType(next); // оптимистично обновляем UI
    try {
      await invoke('api_set_meeting_type', {
        meetingId: meeting.id,
        meetingType: next,
      });
      // Синк типа на сервер: переотправляем встречу - meta включает meeting_type из БД,
      // дашборд обновляет тип по meeting_id (TranscriptEndpoints). Без этого тип менялся
      // только локально, а на дашборде оставалась старая плашка.
      try {
        await invoke('insapp_upload_meeting_by_id', { meetingId: meeting.id });
        console.log('[insapp-meet] meet: тип синхронизирован на сервер ->', next);
      } catch (e) {
        console.warn('[insapp-meet] meet: не удалось синхронизировать тип на сервер', e);
      }
    } catch (error) {
      console.error('[insapp-meet] meet: set-type failed, откат', error);
      setMeetingType(prev); // откат к прежнему значению при ошибке
    }
  };

  // Дата и длительность встречи из created_at (длительности нет в данных -
  // показываем дату; формат как в макете «16 июня 2026»).
  const meetingDate = (() => {
    try {
      return new Date(meeting.created_at).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch {
      return '';
    }
  })();

  const transcriptSynced = transcripts.length > 0;
  // ВАЖНО: бэкенд и все остальные компоненты используют статус "sent" (см. SyncStatus
  // в insapp_server + SummarySyncBadge/TerminalPanel/AiTerminalLauncher). Здесь была
  // опечатка 'synced', из-за которой загруженное на сервер резюме всегда показывалось
  // как «ещё не в облаке».
  const summarySyncedToCloud = hasMarkdownSummary && syncStatus === 'sent';

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-card text-foreground overflow-hidden">
      {/* Шапка встречи (макет «Insapp Pro»):
          строка 1 - редактируемое название (слева) + действия [папка][копировать][Поделиться] (справа);
          строка 2 - ровная мета-строка: дата · длительность · тип (переключатель) · разделитель · чипы синхронизации.
          Все элементы левого края на одной вертикали с контентом резюме ниже. */}
      {transcripts.length > 0 && (
        <div className="px-5 pt-4 pb-3 border-b border-border">
          {/* строка 1: название + действия */}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <EditableTitle
                title={meetingTitle}
                isEditing={isEditingTitle}
                onStartEditing={() => {
                  console.log('[insapp-meet] meet: rename-start');
                  onStartEditTitle();
                }}
                onFinishEditing={() => {
                  console.log('[insapp-meet] meet: rename-finish');
                  onFinishEditTitle();
                }}
                onChange={onTitleChange}
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        console.log('[insapp-meet] meet: open-folder');
                        Analytics.trackButtonClick('open_recording_folder', 'meeting_details');
                        onOpenFolder();
                      }}
                      className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                      aria-label="Открыть папку с записью"
                    >
                      <FolderOpen className="w-[18px] h-[18px] stroke-[1.75]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Открыть папку с записью</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        Analytics.trackButtonClick('copy_summary', 'meeting_details');
                        onCopySummary();
                      }}
                      className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                      aria-label="Копировать резюме"
                    >
                      <Copy className="w-[18px] h-[18px] stroke-[1.75]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Скопировать резюме</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <AiTerminalLauncher
                meetingId={meeting.id}
                meetingTitle={meetingTitle}
                onSummarySaved={onAiSummarySaved}
              />
            </div>
          </div>

          {/* строка 2: ровная мета-строка */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px] text-muted-foreground">
            {meetingDate && (
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />
                {meetingDate}
              </span>
            )}
            {(meeting as any).duration > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                {(meeting as any).duration < 60 ? `${(meeting as any).duration} мин` : `${Math.floor((meeting as any).duration / 60)} ч ${String((meeting as any).duration % 60).padStart(2, '0')} мин`}
              </span>
            )}
            {/* Тип встречи - кликабельный переключатель с шевроном.
                Внутренняя = синий (primary), Внешняя = янтарный. */}
            <button
              type="button"
              onClick={handleToggleMeetingType}
              className={`group inline-flex items-center gap-1.5 font-semibold transition-opacity hover:opacity-80 ${
                isExternal ? 'text-amber-700 dark:text-amber-400' : 'text-primary'
              }`}
              title="Сменить тип встречи: внутренняя / внешняя"
              aria-label="Тип встречи"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              <span className="group-hover:underline underline-offset-2">
                {isExternal ? 'Внешняя' : 'Внутренняя'}
              </span>
              <ChevronDown className="w-3.5 h-3.5 opacity-55" />
            </button>

            <span className="w-px h-3.5 bg-border" />

            {/* Чипы синхронизации с облаком - зелёные когда в облаке. */}
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`inline-flex items-center gap-1.5 font-semibold ${
                      transcriptSynced ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                    }`}
                  >
                    {transcriptSynced ? <CheckCircle2 className="w-3.5 h-3.5" /> : <CloudOff className="w-3.5 h-3.5" />}
                    Транскрипт
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {transcriptSynced ? 'Транскрипт сохранён в облаке Insapp' : 'Транскрипт ещё не в облаке'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`inline-flex items-center gap-1.5 font-semibold ${
                      summarySyncedToCloud ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                    }`}
                  >
                    {summarySyncedToCloud ? <CheckCircle2 className="w-3.5 h-3.5" /> : <CloudOff className="w-3.5 h-3.5" />}
                    Резюме
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {summarySyncedToCloud ? 'Резюме синхронизировано с облаком Insapp' : 'Резюме ещё не в облаке'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Бейдж реального статуса синхронизации резюме + Save/Copy резюме справа. */}
            <div className="ml-auto flex items-center gap-1.5">
              {hasMarkdownSummary && (
                <SummarySyncBadge
                  meetingId={meeting.id}
                  syncStatus={syncStatus}
                  syncedAt={syncedAt}
                />
              )}
              {aiSummary && !isSummaryLoading && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          Analytics.trackButtonClick('save_changes', 'meeting_details');
                          onSaveAll();
                        }}
                        disabled={isSaving}
                        className={`inline-flex items-center justify-center h-8 w-8 rounded-md border transition-colors disabled:opacity-50 ${
                          (isTitleDirty || summaryRef.current?.isDirty)
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-400'
                            : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground'
                        }`}
                      >
                        {isSaving ? (
                          <Loader2 className="w-4 h-4 animate-spin stroke-[1.75]" />
                        ) : (
                          <Save className="w-4 h-4 stroke-[1.75]" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{isSaving ? 'Сохраняю...' : 'Сохранить'}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Вкладки (макет «Insapp Pro»): Транскрипт / AI-резюме / Задачи.
          Активная вкладка - синяя с подчёркиванием. Под шапкой, контент переключается ниже. */}
      {transcripts.length > 0 && (
        <div className="px-5 border-b border-border flex items-center gap-1">
          {([
            { id: 'transcript' as const, label: 'Транскрипт' },
            { id: 'summary' as const, label: 'AI-резюме' },
            { id: 'tasks' as const, label: 'Задачи' },
          ]).map((t) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  console.log('[insapp-meet] meet: tab', t.id);
                  onTabChange(t.id);
                }}
                className={`relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2 ${
                  active
                    ? 'text-primary border-primary font-semibold'
                    : 'text-muted-foreground border-transparent hover:text-foreground'
                }`}
                aria-pressed={active}
              >
                {t.label}
                {t.id === 'tasks' && (
                  <span
                    className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[11px] font-semibold ${
                      active ? 'bg-accent text-accent-foreground' : 'bg-secondary text-muted-foreground'
                    }`}
                  >
                    {tasksCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Вкладка «Транскрипт» - панель транскрипта целиком (логика не тронута). */}
      {activeTab === 'transcript' && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {transcriptSlot}
        </div>
      )}

      {/* Вкладка «Задачи» - список action items, либо аккуратный пустой статус. */}
      {activeTab === 'tasks' && (
        <div className="flex-1 overflow-y-auto min-h-0 p-6">
          {tasks && tasks.length > 0 ? (
            <div className="max-w-[640px] mx-auto flex flex-col gap-2">
              {tasks.map((task, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 px-4 py-3 rounded-xl border border-border bg-card"
                >
                  <span className="mt-0.5 w-5 h-5 rounded-md border-2 border-border shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <div className="text-sm text-foreground leading-snug">{task.text}</div>
                    {task.owner && (
                      <div className="mt-1 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                        Ответственный
                        <span className="px-2 py-0.5 rounded-md bg-accent text-accent-foreground font-medium">
                          {task.owner}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
              <div className="w-16 h-16 mb-4 rounded-2xl bg-accent text-accent-foreground flex items-center justify-center">
                <ListChecks className="w-7 h-7" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">Задач пока нет</h3>
              <p className="text-sm max-w-md">
                Задачи появятся после AI-резюме - Claude выделит пункты к выполнению из транскрипта встречи.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Вкладка «AI-резюме» - всё прежнее поведение панели резюме без изменений. */}
      {activeTab === 'summary' && (
        isSummaryLoading ? (
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-center flex-1">
            <div className="text-center">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mb-4"></div>
              <p className="text-muted-foreground">Делаю AI-резюме...</p>
            </div>
          </div>
        </div>
      ) : !aiSummary ? (
        <div className="flex flex-col h-full">
          {/* Empty state - только подсказка, без старых кнопок.
              AI-резюме делается через центральную кнопку «Сделать AI-резюме» выше. */}
          <div className="flex flex-col items-center justify-center flex-1 px-8 text-center text-muted-foreground">
            <div className="w-16 h-16 mb-4 rounded-2xl bg-accent text-accent-foreground flex items-center justify-center">
              <span className="text-3xl">🤖</span>
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Резюме ещё не сделано</h3>
            <p className="text-sm max-w-md">
              Нажми «Сделать AI-резюме» сверху - откроется терминал, AI напишет резюме встречи в реальном времени.
            </p>
          </div>
        </div>
      ) : transcripts?.length > 0 && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {summaryResponse && (
            <div className="fixed bottom-0 left-0 right-0 bg-card shadow-lg p-4 max-h-1/3 overflow-y-auto">
              <h3 className="text-lg font-semibold mb-2">Meeting Summary</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-card p-4 rounded-lg shadow-sm">
                  <h4 className="font-medium mb-1">Key Points</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.key_points.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="bg-card p-4 rounded-lg shadow-sm mt-4">
                  <h4 className="font-medium mb-1">Action Items</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.action_items.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="bg-card p-4 rounded-lg shadow-sm mt-4">
                  <h4 className="font-medium mb-1">Decisions</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.decisions.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="bg-card p-4 rounded-lg shadow-sm mt-4">
                  <h4 className="font-medium mb-1">Main Topics</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.main_topics.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
              </div>
              {summaryResponse.raw_summary ? (
                <div className="mt-4">
                  <h4 className="font-medium mb-1">Full Summary</h4>
                  <p className="text-sm whitespace-pre-wrap">{summaryResponse.raw_summary}</p>
                </div>
              ) : null}
            </div>
          )}
          <div className="p-6 w-full">
            <BlockNoteSummaryView
              ref={summaryRef}
              summaryData={aiSummary}
              onSave={onSaveSummary}
              onSummaryChange={onSummaryChange}
              onDirtyChange={onDirtyChange}
              status={summaryStatus}
              error={summaryError}
              onRegenerateSummary={() => {
                console.log('[insapp-meet] meet: regenerate-summary');
                Analytics.trackButtonClick('regenerate_summary', 'meeting_details');
                onRegenerateSummary();
              }}
              meeting={{
                id: meeting.id,
                title: meetingTitle,
                created_at: meeting.created_at
              }}
            />
          </div>
          {summaryStatus !== 'idle' && (
            <div className={`mt-4 p-4 rounded-lg ${summaryStatus === 'error' ? 'bg-destructive/10 text-destructive' :
              summaryStatus === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' :
                'bg-accent text-accent-foreground'
              }`}>
              <p className="text-sm font-medium">{getSummaryStatusMessage(summaryStatus)}</p>
            </div>
          )}
        </div>
      )
      )}
    </div>
  );
}
