"use client";

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, FolderOpen, RefreshCw, PanelRight, PanelRightClose } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { RetranscribeDialog } from './RetranscribeDialog';
import { useConfig } from '@/contexts/ConfigContext';


interface TranscriptButtonGroupProps {
  transcriptCount: number;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
  /** Видим ли сейчас правый блок резюме (для иконки тоггла). */
  summaryVisible?: boolean;
  /** Переключить показ правого блока резюме. Если не передан - кнопка не рендерится. */
  onToggleSummary?: () => void;
}


export function TranscriptButtonGroup({
  transcriptCount,
  onCopyTranscript,
  onOpenMeetingFolder,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  summaryVisible,
  onToggleSummary,
}: TranscriptButtonGroupProps) {
  const { betaFeatures } = useConfig();
  const [showRetranscribeDialog, setShowRetranscribeDialog] = useState(false);

  const handleRetranscribeComplete = useCallback(async () => {
    // Refetch transcripts to show the updated data
    if (onRefetchTranscripts) {
      await onRefetchTranscripts();
    }
  }, [onRefetchTranscripts]);

  return (
    <div className="flex items-center justify-center w-full gap-2">
      <ButtonGroup>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            Analytics.trackButtonClick('copy_transcript', 'meeting_details');
            onCopyTranscript();
          }}
          disabled={transcriptCount === 0}
          title={transcriptCount === 0 ? 'Транскрипт пуст' : 'Скопировать транскрипт'}
        >
          <Copy />
          <span className="hidden lg:inline">Скопировать</span>
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="xl:px-4"
          onClick={() => {
            Analytics.trackButtonClick('open_recording_folder', 'meeting_details');
            onOpenMeetingFolder();
          }}
          title="Открыть папку с записью"
        >
          <FolderOpen className="xl:mr-2" size={18} />
          <span className="hidden lg:inline">Папка</span>
        </Button>

        {/* Тоггл правого блока AI-резюме. Иногда нужен только транскрипт -
            эта кнопка скрывает/показывает панель резюме справа. */}
        {onToggleSummary && (
          <Button
            size="sm"
            variant="outline"
            className={summaryVisible ? 'bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100' : ''}
            onClick={() => {
              Analytics.trackButtonClick('toggle_summary_panel', 'meeting_details');
              onToggleSummary();
            }}
            title={summaryVisible ? 'Скрыть блок резюме' : 'Показать блок резюме'}
            aria-pressed={summaryVisible}
          >
            {summaryVisible ? <PanelRightClose /> : <PanelRight />}
            <span className="hidden lg:inline">Резюме</span>
          </Button>
        )}

        {/* Кнопка «Перераспознать» (Enhance) убрана - она не про AI-резюме,
            а про повторный прогон Whisper с другими параметрами. Geo сказал
            она путает. Доступна через Settings → Beta если кому понадобится. */}
      </ButtonGroup>

      {betaFeatures.importAndRetranscribe && meetingId && meetingFolderPath && (
        <RetranscribeDialog
          open={showRetranscribeDialog}
          onOpenChange={setShowRetranscribeDialog}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onComplete={handleRetranscribeComplete}
        />
      )}
    </div>
  );
}
