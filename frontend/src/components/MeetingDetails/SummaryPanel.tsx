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
import { Save, Copy, Loader2 } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { RefObject } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface SummaryPanelProps {
  meeting: {
    id: string;
    title: string;
    created_at: string;
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
}: SummaryPanelProps) {
  const isSummaryLoading = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';

  // sync_status и synced_at лежат в JSON summary_processes.result,
  // которое page.tsx распарсивает и кладёт в aiSummary целиком.
  // Тип Summary не описывает эти поля - достаём через as any.
  const summaryAny = aiSummary as any;
  const syncStatus: string | undefined = summaryAny?.sync_status;
  const syncedAt: string | undefined = summaryAny?.synced_at;
  const hasMarkdownSummary = !!summaryAny?.markdown;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white overflow-hidden">
      {/* Title area - все элементы в одной flex-row с единой системой стилей:
          - Primary CTA: gradient blue→purple (AI - центральное действие)
          - Secondary buttons: outline gray-300, h-8
          - Badges: rounded-full pills с iconom
          Все элементы high=32px (h-8) для единой высоты. */}
      {transcripts.length > 0 && (
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="flex flex-wrap items-center gap-2">
            <AiTerminalLauncher
              meetingId={meeting.id}
              meetingTitle={meetingTitle}
              onSummarySaved={onAiSummarySaved}
            />
            {hasMarkdownSummary && (
              <SummarySyncBadge
                meetingId={meeting.id}
                syncStatus={syncStatus}
                syncedAt={syncedAt}
              />
            )}
            {/* Save/Copy - icon-only кнопки h-8 w-8 для компактности */}
            {aiSummary && !isSummaryLoading && (
              <TooltipProvider delayDuration={200}>
                <div className="ml-auto flex items-center gap-1">
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
                            ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                            : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
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
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          Analytics.trackButtonClick('copy_summary', 'meeting_details');
                          onCopySummary();
                        }}
                        className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <Copy className="w-4 h-4 stroke-[1.75]" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Скопировать резюме</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            )}
          </div>
        </div>
      )}

      {isSummaryLoading ? (
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-center flex-1">
            <div className="text-center">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mb-4"></div>
              <p className="text-gray-600">Делаю AI-резюме...</p>
            </div>
          </div>
        </div>
      ) : !aiSummary ? (
        <div className="flex flex-col h-full">
          {/* Empty state - только подсказка, без старых кнопок.
              AI-резюме делается через центральную кнопку «Сделать AI-резюме» выше. */}
          <div className="flex flex-col items-center justify-center flex-1 px-8 text-center text-gray-500">
            <div className="w-16 h-16 mb-4 rounded-full bg-gray-100 flex items-center justify-center">
              <span className="text-3xl">🤖</span>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Резюме ещё не сделано</h3>
            <p className="text-sm max-w-md">
              Нажми «Сделать AI-резюме» сверху - откроется терминал, AI напишет резюме встречи в реальном времени.
            </p>
          </div>
        </div>
      ) : transcripts?.length > 0 && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {summaryResponse && (
            <div className="fixed bottom-0 left-0 right-0 bg-white shadow-lg p-4 max-h-1/3 overflow-y-auto">
              <h3 className="text-lg font-semibold mb-2">Meeting Summary</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white p-4 rounded-lg shadow-sm">
                  <h4 className="font-medium mb-1">Key Points</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.key_points.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="bg-white p-4 rounded-lg shadow-sm mt-4">
                  <h4 className="font-medium mb-1">Action Items</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.action_items.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="bg-white p-4 rounded-lg shadow-sm mt-4">
                  <h4 className="font-medium mb-1">Decisions</h4>
                  <ul className="list-disc pl-4">
                    {summaryResponse.summary.decisions.blocks.map((block, i) => (
                      <li key={i} className="text-sm">{block.content}</li>
                    ))}
                  </ul>
                </div>
                <div className="bg-white p-4 rounded-lg shadow-sm mt-4">
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
            <div className={`mt-4 p-4 rounded-lg ${summaryStatus === 'error' ? 'bg-red-100 text-red-700' :
              summaryStatus === 'completed' ? 'bg-green-100 text-green-700' :
                'bg-blue-100 text-blue-700'
              }`}>
              <p className="text-sm font-medium">{getSummaryStatusMessage(summaryStatus)}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
