'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { RecordingControls } from '@/components/RecordingControls';
import { RecordingDeviceBar } from '@/components/RecordingDeviceBar';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { StatusOverlays } from '@/app/_components/StatusOverlays';
import Analytics from '@/lib/analytics';
import { SettingsModals } from './_components/SettingsModal';
import { TranscriptPanel } from './_components/TranscriptPanel';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { indexedDBService } from '@/services/indexedDBService';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { UploadOptInToggle } from '@/components/UploadOptInToggle';
import HomeDashboard from '@/components/HomeDashboard';
import RecordingHero from '@/components/RecordingHero';
import RecordingDockStatus from '@/components/RecordingDockStatus';
import { SaveMeetingModal } from '@/components/SaveMeetingModal';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { Loader2 } from 'lucide-react';

/** Чистый экран обработки после остановки записи: спиннер + статус.
 *  Показывается между остановкой и открытием готовой встречи - ВМЕСТО старого
 *  realtime-вида транскрипта (баг «беспонтовый промежуточный экран от старой версии»). */
function ProcessingScreen({ status }: { status: RecordingStatus }) {
  const text =
    status === RecordingStatus.SAVING ? 'Сохраняю встречу...'
      : status === RecordingStatus.UPLOADING_TO_SERVER ? 'Отправляю в облако Insapp...'
        : 'Готовлю транскрипт встречи...';
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-8 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
      <h2 className="mb-1.5 text-lg font-semibold text-foreground">{text}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Это займёт несколько секунд - встреча откроется автоматически.
      </p>
    </div>
  );
}

export default function Home() {
  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  // Окно «Сохранить встречу» при нажатии «Стоп» (как #bStopModal в макете).
  // DEV: ?dev_screen=save открывает окно сразу - для проверки вёрстки в браузере.
  const [showSaveModal, setShowSaveModal] = useState(
    typeof window !== 'undefined'
    && process.env.NODE_ENV === 'development'
    && new URLSearchParams(window.location.search).get('dev_screen') === 'save'
  );

  // Use contexts for state management
  const { meetingTitle, setMeetingTitle } = useTranscripts();
  const { transcriptModelConfig, selectedDevices } = useConfig();
  const recordingState = useRecordingState();

  // Extract status from global state
  const { status, isStopping, isProcessing, isSaving } = recordingState;

  // Hooks
  usePermissionCheck();
  const { setIsMeetingActive, isCollapsed: sidebarCollapsed, refetchMeetings } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(isRecording, setIsRecordingState, setIsMeetingActive);
  const { handleRecordingStart } = useRecordingStart(isRecording, setIsRecordingState, showModal);

  // Get handleRecordingStop function and setIsStopping (state comes from global context)
  const { handleRecordingStop, setIsStopping } = useRecordingStop(
    setIsRecordingState,
    setIsRecordingDisabled
  );

  // Recovery hook
  const {
    recoverableMeetings,
    isLoading: isLoadingRecovery,
    isRecovering,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting
  } = useTranscriptRecovery();

  const router = useRouter();

  useEffect(() => {
    // Track page view
    Analytics.trackPageView('home');
  }, []);

  // Пилюля-индикатор (отдельное окно) просит показать окно «Сохранить встречу» -
  // тот же путь, что кнопка «Стоп» в приложении. Слушатель пилюли в useRecordingStop
  // дёргает этот глобальный колбэк.
  useEffect(() => {
    (window as any).requestSaveMeeting = () => setShowSaveModal(true);
    return () => { delete (window as any).requestSaveMeeting; };
  }, []);

  // Startup recovery check
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        // Skip recovery check if currently recording or processing stop
        // This prevents the recovery dialog from showing when:
        if (recordingState.isRecording ||
          status === RecordingStatus.STOPPING ||
          status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          status === RecordingStatus.SAVING) {
          console.log('Skipping recovery check - recording in progress or processing');
          return;
        }

        // 1. Clean up old meetings (7+ days)
        try {
          await indexedDBService.deleteOldMeetings(7);
        } catch (error) {
          console.warn('⚠️ Failed to clean up old meetings:', error);
        }

        // 2. Clean up saved meetings (24+ hours after save)
        try {
          await indexedDBService.deleteSavedMeetings(24);
        } catch (error) {
          console.warn('⚠️ Failed to clean up saved meetings:', error);
        }

        // 3. Always check for recoverable meetings on startup
        // Don't skip based on sessionStorage - we need to check every time
        await checkForRecoverableTranscripts();
      } catch (error) {
        console.error('Failed to perform startup checks:', error);
      }
    };

    performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  // Watch for recoverable meetings changes and show dialog once per session
  useEffect(() => {
    // Only show dialog if we have meetings and haven't shown it yet this session
    if (recoverableMeetings.length > 0) {
      const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
      if (!shownThisSession) {
        setShowRecoveryDialog(true);
        sessionStorage.setItem('recovery_dialog_shown', 'true');
      }
    }
  }, [recoverableMeetings]);

  // Handle recovery with toast notifications and navigation
  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);

      if (result.success) {
        toast.success('Встреча восстановлена!', {
          description: result.audioRecoveryStatus?.status === 'success'
            ? 'Транскрипт и аудио восстановлены'
            : 'Транскрипт восстановлен (без аудио)',
          action: result.meetingId ? {
            label: 'Открыть встречу',
            onClick: () => {
              router.push(`/meeting-details?id=${result.meetingId}`);
            }
          } : undefined,
          duration: 10000,
        });

        // Refresh sidebar to show the newly recovered meeting
        await refetchMeetings();

        // If no more recoverable meetings, clear session flag so dialog can show again
        if (recoverableMeetings.length === 0) {
          sessionStorage.removeItem('recovery_dialog_shown');
        }

        // Auto-navigate after a short delay
        if (result.meetingId) {
          setTimeout(() => {
            router.push(`/meeting-details?id=${result.meetingId}`);
          }, 2000);
        }
      }
    } catch (error) {
      toast.error('Не удалось восстановить встречу', {
        description: error instanceof Error ? error.message : 'Неизвестная ошибка',
      });
      throw error;
    }
  };

  // Handle dialog close - clear session flag if no meetings left
  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
    // If user closes dialog and there are no more meetings, clear the flag
    // This allows the dialog to show again next session if new meetings appear
    if (recoverableMeetings.length === 0) {
      sessionStorage.removeItem('recovery_dialog_shown');
    }
  };

  // «Сохранить» в окне сохранения: применяем название, делаем РЕАЛЬНУЮ остановку записи
  // (тот же путь, что у кнопки «Стоп»), затем пост-обработка и сохранение встречи.
  const handleConfirmSave = async (name: string, type: 'in' | 'out') => {
    setShowSaveModal(false);
    setIsStopping(true);
    setMeetingTitle(name);
    try {
      const dataDir = await appDataDir();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await invoke('stop_recording', { args: { save_path: `${dataDir}/recording-${ts}.wav` } });
    } catch (e) {
      console.error('[insapp-meet] save-modal: ошибка реальной остановки', e);
    }
    // Имя и тип передаём ЯВНО (React state setMeetingTitle не успевает примениться
    // до сохранения): overrideName перебивает дефолтное backend-имя, тип уходит в БД и на сервер.
    handleRecordingStop(true, name, type === 'out' ? 'external' : 'internal');
  };

  // Computed values using global status
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;

  // DEV: показать экран записи в браузерной dev-версии (?dev_screen=recording) для
  // вёрстки без реальной записи. В собранном приложении (Tauri) не влияет.
  const devForceRec = typeof window !== 'undefined'
    && process.env.NODE_ENV === 'development'
    && new URLSearchParams(window.location.search).get('dev_screen') === 'recording';
  const isRecScreen = recordingState.isRecording || devForceRec;

  // Главная-дашборд показывается в простое. Во время записи/обработки/сохранения -
  // экран записи. Логику записи это не трогает.
  const showHome = !isRecScreen
    && status !== RecordingStatus.PROCESSING_TRANSCRIPTS
    && status !== RecordingStatus.SAVING
    && status !== RecordingStatus.STOPPING
    && status !== RecordingStatus.UPLOADING_TO_SERVER;

  return (
    <motion.div className="flex flex-col h-screen bg-background">
      {/* All Modals supported*/}
      <SettingsModals
        modals={modals}
        messages={messages}
        onClose={hideModal}
      />

      {/* Recovery Dialog */}
      <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />
      <div className="flex flex-1 overflow-hidden">
        {showHome ? (
          <HomeDashboard />
        ) : isRecScreen ? (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Полноэкранная шапка идущей записи (орб/таймер/тип) */}
            <RecordingHero />
            <div className="flex-1 min-h-0 overflow-hidden">
              <TranscriptPanel
                isProcessingStop={isProcessingStop}
                isStopping={isStopping}
                showModal={showModal}
              />
            </div>

            {/* Нижний док записи - В ПОТОКЕ под транскриптом (не fixed-overlay, как было).
                Раньше панель плавала поверх ленты и перекрывала её (баг «перекрывающиеся
                элементы»). Теперь: устройства + облако слева, Пауза/Стоп справа -
                единая нижняя панель, как rec-dock в макете B. */}
            <div className="flex-none border-t border-border bg-card px-6 py-3">
                <div className="flex w-full items-center gap-x-4 gap-y-2">
                  <div className="flex items-center gap-x-4 min-w-0">
                    <RecordingDockStatus />
                    <RecordingDeviceBar isRecording={recordingState.isRecording} />
                    <UploadOptInToggle visible={recordingState.isRecording} />
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <RecordingControls
                      isRecording={recordingState.isRecording}
                      onRecordingStop={(callApi = true) => handleRecordingStop(callApi)}
                      onRecordingStart={handleRecordingStart}
                      onTranscriptReceived={() => { }}
                      onStopInitiated={() => setIsStopping(true)}
                      onRequestStop={() => setShowSaveModal(true)}
                      onTranscriptionError={(message) => {
                        showModal('errorAlert', message);
                      }}
                      isRecordingDisabled={isRecordingDisabled}
                      isParentProcessing={isProcessingStop}
                      selectedDevices={selectedDevices}
                      meetingName={meetingTitle}
                    />
                  </div>
                </div>
              </div>
          </div>
        ) : (
          /* Пост-стоп: чистый лоадер вместо старого realtime-вида (баг 1).
             Встреча откроется автоматически (router.push в useRecordingStop). */
          <ProcessingScreen status={status} />
        )}

        {/* Status Overlays - Processing, Saving, Uploading */}
        <StatusOverlays
          isProcessing={status === RecordingStatus.PROCESSING_TRANSCRIPTS && !recordingState.isRecording}
          isSaving={status === RecordingStatus.SAVING}
          isUploading={status === RecordingStatus.UPLOADING_TO_SERVER}
          sidebarCollapsed={sidebarCollapsed}
        />
      </div>

      {/* Окно «Сохранить встречу» - открывается по «Стоп», запускает остановку+сохранение */}
      <SaveMeetingModal
        open={showSaveModal}
        defaultName={
          meetingTitle && meetingTitle !== '+ New Call'
            ? meetingTitle
            : `Встреча ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}, ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
        }
        willUpload={typeof window !== 'undefined' ? sessionStorage.getItem('insapp_upload_to_cloud') !== 'false' : true}
        onCancel={() => setShowSaveModal(false)}
        onConfirm={handleConfirmSave}
      />
    </motion.div>
  );
}
