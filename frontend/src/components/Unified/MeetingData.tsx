'use client';

/**
 * Загрузка выбранной встречи для главного экрана: метаданные и расшифровка (постранично),
 * резюме в любом формате (markdown / BlockNote / старый), обновление по событию
 * ai-summary-saved и старый путь авто-генерации после записи (source=recording).
 *
 * Логика перенесена без изменений из app/meeting-details/page.tsx (MeetingDetailsContent):
 * id встречи и source теперь приходят пропсами (а не из адреса), вид - MeetingView.
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Loader2 } from 'lucide-react';
import { Transcript, Summary } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useConfig } from '@/contexts/ConfigContext';
import { usePaginatedTranscripts } from '@/hooks/usePaginatedTranscripts';
import Analytics from '@/lib/analytics';
import { MeetingView } from './MeetingView';
import type { MeetingListItem } from './UnifiedSidebar';

interface MeetingDetailsResponse {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  transcripts: Transcript[];
  folder_path?: string;
  // Тип встречи: 'internal' (внутренняя) | 'external' (внешняя).
  meeting_type?: string;
}

export function MeetingData({
  meetingId, source, listItem, onMissing, onDeleted,
}: {
  meetingId: string;
  source: string | null;
  /** Строка встречи из списка: статусы «на сервере», есть ли резюме. */
  listItem?: MeetingListItem;
  /** Встреча не нашлась (удалена) - показать другую. */
  onMissing: () => void;
  onDeleted: (id: string) => void;
}) {
  const { setCurrentMeeting, refetchMeetings, stopSummaryPolling } = useSidebar();
  const { isAutoSummary } = useConfig(); // Get auto-summary toggle state
  const [meetingDetails, setMeetingDetails] = useState<MeetingDetailsResponse | null>(null);
  const [meetingSummary, setMeetingSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [shouldAutoGenerate, setShouldAutoGenerate] = useState<boolean>(false);
  const [hasCheckedAutoGen, setHasCheckedAutoGen] = useState<boolean>(false);

  // Use pagination hook for efficient transcript loading
  const {
    metadata,
    segments,
    transcripts,
    isLoading: isLoadingTranscripts,
    isLoadingMore,
    hasMore,
    totalCount,
    loadedCount,
    loadMore,
    refetch,
    error: transcriptError,
  } = usePaginatedTranscripts({ meetingId: meetingId || '' });

  // Check if gemma3:1b model is available in Ollama
  const checkForGemmaModel = useCallback(async (): Promise<boolean> => {
    try {
      const models = await invoke('get_ollama_models', { endpoint: null }) as any[];
      const hasGemma = models.some((m: any) => m.name === 'gemma3:1b');
      return hasGemma;
    } catch (error) {
      console.error('❌ Failed to check Ollama models:', error);
      return false;
    }
  }, []);

  // Set up auto-generation - respects DB as source of truth
  const setupAutoGeneration = useCallback(async () => {
    if (hasCheckedAutoGen) return; // Only check once

    // Only auto-generate if navigated from recording
    if (source !== 'recording') {
      setHasCheckedAutoGen(true);
      return;
    }

    // Respect user's auto-summary toggle preference
    if (!isAutoSummary) {
      console.log('Auto-summary is disabled in settings');
      setHasCheckedAutoGen(true);
      return;
    }

    try {
      // Check what's currently in database
      const currentConfig = await invoke('api_get_model_config') as any;

      // If DB already has a model, use it (never override!)
      if (currentConfig && currentConfig.model) {
        console.log('Using existing model from DB:', currentConfig.model);
        setShouldAutoGenerate(true);
        setHasCheckedAutoGen(true);
        return;
      }

      // DB is empty - check if gemma3:1b exists as fallback
      const hasGemma = await checkForGemmaModel();

      if (hasGemma) {
        console.log('💾 DB empty, using gemma3:1b as initial default');

        await invoke('api_save_model_config', {
          provider: 'ollama',
          model: '',
          whisperModel: 'large-v3',
          apiKey: null,
          ollamaEndpoint: null,
        });

        setShouldAutoGenerate(true);
      } else {
        console.log('⚠️ No model configured and gemma3:1b not found');
      }
    } catch (error) {
      console.error('❌ Failed to setup auto-generation:', error);
    }

    setHasCheckedAutoGen(true);
  }, [hasCheckedAutoGen, checkForGemmaModel, source, isAutoSummary]);

  // Sync meeting metadata from pagination hook to meeting details state
  useEffect(() => {
    if (metadata && (!meetingId || meetingId === 'intro-call')) {
      return;
    }

    if (metadata) {
      setMeetingDetails({
        id: metadata.id,
        title: metadata.title,
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
        transcripts: transcripts, // Paginated transcripts from hook
        folder_path: metadata.folder_path, // For retranscription feature
        meeting_type: (metadata as any).meeting_type ?? 'internal',
        duration: (metadata as any).duration,
      } as any);

      // Sync with sidebar context
      setCurrentMeeting({ id: metadata.id, title: metadata.title });
    }
  }, [metadata, transcripts, meetingId, setCurrentMeeting]);

  // Handle transcript loading errors
  useEffect(() => {
    if (transcriptError) {
      console.error('Error loading transcripts:', transcriptError);
      setError(transcriptError);
    }
  }, [transcriptError]);

  // Kept for compatibility with onMeetingUpdated callback (pagination hook refetches itself)
  const fetchMeetingDetails = useCallback(async () => {
    if (!meetingId || meetingId === 'intro-call') {
      return;
    }
  }, [meetingId]);

  // Reset states when meetingId changes (prevent race conditions)
  useEffect(() => {
    setMeetingDetails(null);
    setMeetingSummary(null);
    setError(null);
    setIsLoading(true);
    setHasCheckedAutoGen(false);
    setShouldAutoGenerate(false);
  }, [meetingId]);

  // Cleanup: Stop polling when navigating away from a meeting
  useEffect(() => {
    return () => {
      if (meetingId) {
        stopSummaryPolling(meetingId);
      }
    };
  }, [meetingId, stopSummaryPolling]);

  useEffect(() => {
    if (!meetingId || meetingId === 'intro-call') {
      setError("No meeting selected");
      setIsLoading(false);
      Analytics.trackPageView('meeting_details');
      return;
    }

    Analytics.trackPageView('meeting_details');
    setMeetingDetails(null);
    setMeetingSummary(null);
    setError(null);
    setIsLoading(true);

    const fetchMeetingSummary = async () => {
      try {
        const summary = await invoke('api_get_summary', {
          meetingId: meetingId,
        }) as any;

        // No summary yet (idle) or failed without data
        if (summary.status === 'idle' || (!summary.data && summary.status === 'error')) {
          setMeetingSummary(null);
          return;
        }

        const summaryData = summary.data || {};

        // Parse if it's a JSON string (backend may return double-encoded JSON)
        let parsedData = summaryData;
        if (typeof summaryData === 'string') {
          try {
            parsedData = JSON.parse(summaryData);
          } catch (e) {
            parsedData = {};
          }
        }

        // Priority 1: BlockNote JSON format
        if (parsedData.summary_json) {
          setMeetingSummary(parsedData as any);
          return;
        }

        // Priority 2: Markdown format
        if (parsedData.markdown) {
          setMeetingSummary(parsedData as any);
          return;
        }

        // Legacy format - apply formatting
        const { MeetingName, _section_order, ...restSummaryData } = parsedData;
        const formattedSummary: Summary = {};
        const sectionKeys = _section_order || Object.keys(restSummaryData);

        for (const key of sectionKeys) {
          try {
            const section = restSummaryData[key];
            if (section &&
              typeof section === 'object' &&
              'title' in section &&
              'blocks' in section) {
              const typedSection = section as { title?: string; blocks?: any[] };

              if (Array.isArray(typedSection.blocks)) {
                formattedSummary[key] = {
                  title: typedSection.title || key,
                  blocks: typedSection.blocks.map((block: any) => ({
                    ...block,
                    color: 'default',
                    content: block?.content?.trim() || ''
                  }))
                };
              } else {
                formattedSummary[key] = {
                  title: typedSection.title || key,
                  blocks: []
                };
              }
            }
          } catch (error) {
            console.warn(`LEGACY FORMAT: Error processing section ${key}:`, error);
          }
        }

        setMeetingSummary(formattedSummary);
      } catch (error) {
        console.error('FETCH SUMMARY: Error fetching meeting summary:', error);
        // Don't set error state for summary fetch failure, set to null to show generate button
        setMeetingSummary(null);
      }
    };

    const loadData = async () => {
      try {
        await fetchMeetingSummary();
      } finally {
        setIsLoading(false);
      }
    };

    loadData();

    // Событие «AI-резюме сохранено» из backend (фоновое резюме, пересоздание) -
    // подтягиваем резюме, иначе экран остался бы с «Резюме ещё не сделано».
    let unlisten: UnlistenFn | null = null;
    let alive = true;
    listen<string>('ai-summary-saved', (event) => {
      if (event.payload === meetingId) {
        fetchMeetingSummary();
      }
    }).then((fn) => { if (alive) unlisten = fn; else fn(); });

    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, [meetingId]);

  // Auto-generation check: runs when meeting is loaded with no summary
  useEffect(() => {
    const checkAutoGen = async () => {
      if (
        meetingDetails &&
        meetingSummary === null &&
        meetingDetails.transcripts &&
        meetingDetails.transcripts.length > 0 &&
        !hasCheckedAutoGen
      ) {
        await setupAutoGeneration();
      }
    };

    checkAutoGen();
  }, [meetingDetails, meetingSummary, hasCheckedAutoGen, setupAutoGeneration]);

  // Прямой обработчик сохранения AI-резюме - обновляем экран сразу, не дожидаясь события.
  const handleAiSummarySaved = useCallback((markdown: string) => {
    setMeetingSummary({
      markdown,
      format: 'markdown',
      source: 'ai_terminal',
    } as any);
  }, []);

  if (error) {
    const notFound = /not found|не найден|No meeting|meeting details/i.test(error);
    return (
      <>
        <section className="col-span-2 flex min-h-0 flex-col items-center justify-center rounded-[28px] bg-im-sheet px-8 text-center">
          <h2 className="m-0 text-[18px] font-bold text-im-ink">{notFound ? 'Встреча не найдена' : 'Не удалось открыть встречу'}</h2>
          <p className="mt-1.5 max-w-sm text-[13.5px] leading-5 text-im-mut">
            {notFound
              ? 'Возможно, её удалили. Откройте другую встречу из списка слева.'
              : 'Не получилось загрузить расшифровку. Попробуйте открыть встречу ещё раз.'}
          </p>
          <button
            type="button"
            onClick={onMissing}
            className="mt-5 inline-flex h-10 items-center rounded-[20px] bg-im-acc px-4 text-[14px] font-semibold text-white hover:bg-im-acc-h"
          >
            Открыть последнюю встречу
          </button>
        </section>
      </>
    );
  }

  // Show loading while initial data loads
  if ((isLoading || isLoadingTranscripts) || !meetingDetails) {
    return (
      <>
        <section className="grid min-h-0 place-items-center rounded-[28px] bg-im-sheet" aria-busy="true">
          <Loader2 className="h-6 w-6 animate-spin text-im-mut2" />
        </section>
        <section className="min-h-0 rounded-[28px] bg-im-sheet" aria-hidden="true" />
      </>
    );
  }

  return (
    <MeetingView
      meeting={meetingDetails}
      summaryData={meetingSummary}
      listItem={listItem}
      shouldAutoGenerate={shouldAutoGenerate}
      onAutoGenerateComplete={() => setShouldAutoGenerate(false)}
      onMeetingUpdated={async () => {
        await fetchMeetingDetails();
        await refetchMeetings();
      }}
      onRefetchTranscripts={refetch}
      onAiSummarySaved={handleAiSummarySaved}
      segments={segments}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      totalCount={totalCount}
      loadedCount={loadedCount}
      onLoadMore={loadMore}
      onDeleted={onDeleted}
    />
  );
}
