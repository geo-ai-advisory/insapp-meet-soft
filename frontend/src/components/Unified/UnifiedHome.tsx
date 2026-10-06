'use client';

/**
 * Единый главный экран INmeet (финальный дизайн 29.09.2026, эталон round3/concepts/b-air):
 * слева - список встреч и плашка записи, в центре и справа - выбранная встреча (резюме +
 * расшифровка) или идущая запись (живая лента + участники). Маршрут один - «/»:
 *  - «/?id=<встреча>» - открыть встречу (так же открываются старые ссылки /meeting-details?id=...);
 *  - во время записи центр показывает живую ленту; из списка можно открыть прошлую встречу
 *    и вернуться к записи нажатием на строку «Идёт запись».
 *
 * Логика записи перенесена без изменений из старой главной (app/page.tsx): useRecordingStart,
 * useRecordingStop, RecordingStateContext, восстановление встреч, окно «Сохранить встречу».
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { Loader2, Mic, Upload } from 'lucide-react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useStartupPermissions, PERMISSIONS_CHANGED_EVENT } from '@/hooks/useStartupPermissions';
import { useIsLinux } from '@/hooks/usePlatform';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import Analytics from '@/lib/analytics';
import { SettingsModals } from '@/app/_components/SettingsModal';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useRecordingClock } from '@/hooks/useRecordingClock';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { SaveMeetingModal } from '@/components/SaveMeetingModal';
import { describeRecordingStartError } from '@/components/RecordingControls';
import { indexedDBService } from '@/services/indexedDBService';
import { resetLiveSpeakerNames } from '@/hooks/useSpeakerNames';
import { defaultMeetingName, initialsOf, isAutoMeetingTitle, parseMeetingDate } from '@/lib/meetingFormat';
import { UnifiedSidebar, MeetingListItem } from './UnifiedSidebar';
import { StartPlate, RecordingPlate } from './RecordPlate';
import { LiveView, LiveKind } from './LiveView';
import { MeetingData } from './MeetingData';

const COLS_MEETING = '264px minmax(0,1fr) clamp(340px,34.4vw,480px)';
const COLS_LIVE = '264px minmax(0,1fr) clamp(300px,25.94vw,380px)';
const COLS_SINGLE = '264px minmax(0,1fr)';

/** После «Стоп»: сохраняем встречу - спиннер вместо старого realtime-вида. */
function ProcessingSheet({ status }: { status: RecordingStatus }) {
  const text =
    status === RecordingStatus.SAVING ? 'Сохраняю встречу…'
      : status === RecordingStatus.UPLOADING_TO_SERVER ? 'Отправляю на сервер Insapp…'
        : status === RecordingStatus.STOPPING ? 'Останавливаю запись…'
          : status === RecordingStatus.COMPLETED ? 'Готово - открываю встречу…'
            : 'Завершаю распознавание…';
  return (
    <section className="flex min-h-0 flex-col items-center justify-center rounded-[28px] bg-im-sheet px-8 text-center" aria-live="polite">
      <i className="im-sh-cookie12 mb-5 grid h-14 w-14 place-items-center bg-im-butter not-italic text-im-on-tone" aria-hidden="true">
        <Loader2 className="h-6 w-6 animate-spin" />
      </i>
      <h2 className="m-0 text-[18px] font-bold leading-6 text-im-ink">{text}</h2>
      <p className="mt-1.5 max-w-sm text-[13.5px] leading-5 text-im-mut">
        Это займёт несколько секунд - встреча откроется автоматически.
      </p>
    </section>
  );
}

/** Встреч ещё нет. */
function EmptySheet({ loading }: { loading: boolean }) {
  const { openImportDialog } = useImportDialog();
  if (loading) {
    return (
      <section className="grid min-h-0 place-items-center rounded-[28px] bg-im-sheet" aria-busy="true">
        <Loader2 className="h-6 w-6 animate-spin text-im-mut2" />
      </section>
    );
  }
  return (
    <section className="flex min-h-0 flex-col items-center justify-center rounded-[28px] bg-im-sheet px-8 text-center">
      <i className="im-sh-cookie12 mb-5 grid h-16 w-16 place-items-center bg-im-butter not-italic text-im-on-tone" aria-hidden="true">
        <Mic className="h-7 w-7" />
      </i>
      <h2 className="m-0 text-[21px] font-bold leading-7 tracking-[-0.012em] text-im-ink">Здесь появятся ваши встречи</h2>
      <p className="mt-2 max-w-md text-[14px] leading-[21px] text-im-mut">
        Нажмите «Начать запись» слева внизу - расшифровка пойдёт в реальном времени,
        а резюме появится после встречи. Готовую запись можно загрузить файлом.
      </p>
      <button
        type="button"
        onClick={() => openImportDialog()}
        className="mt-5 inline-flex h-10 items-center gap-2 rounded-[20px] bg-white pl-3 pr-4 text-[14px] font-semibold text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line2)] transition-[background,border-radius] duration-200 hover:bg-im-hover active:rounded-xl"
      >
        <Upload className="h-5 w-5" />
        Загрузить запись
      </button>
    </section>
  );
}

/** Нет доступа к микрофону - короткая подсказка над кнопкой записи. */
function MicPermissionNote() {
  const isLinux = useIsLinux();
  const { hasMicrophone, isChecking, checkPermissions } = usePermissionCheck();
  // разрешения только что спросили при запуске - перепроверить, чтобы подсказка не висела зря
  useEffect(() => {
    const onChange = () => { checkPermissions(); };
    window.addEventListener(PERMISSIONS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PERMISSIONS_CHANGED_EVENT, onChange);
  }, [checkPermissions]);
  if (isLinux || isChecking || hasMicrophone) return null;
  return (
    <div className="mb-2 rounded-[18px] bg-[#FFF6E5] px-3.5 py-2.5 text-[12.5px] leading-[17px] text-[#93370D]">
      <b className="font-semibold">Нет доступа к микрофону.</b> Разрешите его в системных настройках.
      <div className="mt-1.5 flex gap-3 font-semibold">
        <button
          type="button"
          onClick={() => invoke('open_system_settings', { preferencePane: 'Privacy_Microphone' }).catch(() => {})}
          className="underline-offset-2 hover:underline"
        >
          Открыть настройки
        </button>
        <button type="button" onClick={() => checkPermissions()} className="underline-offset-2 hover:underline">
          Проверить снова
        </button>
      </div>
    </div>
  );
}

export default function UnifiedHome() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const idParam = searchParams.get('id');
  const source = searchParams.get('source');

  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  // Окно «Сохранить встречу» при нажатии «Стоп».
  const [showSaveModal, setShowSaveModal] = useState(false);
  // DEV: ?dev_screen=save - сразу окно сохранения, ?dev_screen=recording - экран записи
  // (для проверки вёрстки в браузере). Читаем после монтирования, чтобы не расходиться
  // с заранее собранной страницей. В собранном приложении не влияет.
  const [devScreen, setDevScreen] = useState<string | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const v = new URLSearchParams(window.location.search).get('dev_screen');
    setDevScreen(v);
    if (v === 'save') setShowSaveModal(true);
  }, []);
  // Во время записи центр показывает живую ленту; можно открыть прошлую встречу и вернуться.
  const [viewLive, setViewLive] = useState(true);
  const [liveType, setLiveType] = useState<LiveKind>('in');
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [me, setMe] = useState<{ name: string; initials: string }>({ name: '', initials: 'Вы' });

  // Use contexts for state management
  const { meetingTitle, setMeetingTitle, discardCurrentMeeting } = useTranscripts();
  const { transcriptModelConfig, selectedDevices } = useConfig();
  const recordingState = useRecordingState();
  useStartupPermissions(recordingState.isRecording);
  const { status, isStopping, isProcessing } = recordingState;

  // Hooks
  const { setIsMeetingActive, refetchMeetings, meetings, meetingsLoaded } = useSidebar();
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
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting
  } = useTranscriptRecovery();

  useEffect(() => {
    Analytics.trackPageView('home');
    invoke<{ full_name?: string }>('insapp_get_identity')
      .then((id) => {
        const name = (id?.full_name || '').trim();
        if (name) setMe({ name, initials: initialsOf(name) });
      })
      .catch(() => {});
  }, []);

  // Пилюля-индикатор (отдельное окно) просит показать окно «Сохранить встречу» -
  // тот же путь, что кнопка «Стоп» в приложении.
  useEffect(() => {
    (window as any).requestSaveMeeting = () => setShowSaveModal(true);
    return () => { delete (window as any).requestSaveMeeting; };
  }, []);

  // Проверка прерванных записей - ОДИН раз при запуске приложения. Главный экран теперь не
  // размонтируется после «Стоп» (раньше уходили на страницу встречи), и повторная проверка сразу после
  // сохранения находила только что остановленную запись -> пустое окно «Recover Interrupted Meetings».
  const startupCheckDone = useRef(false);
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        if (startupCheckDone.current) return;
        if (recordingState.isRecording ||
          status === RecordingStatus.STOPPING ||
          status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          status === RecordingStatus.SAVING) {
          return;
        }
        startupCheckDone.current = true;
        try {
          await indexedDBService.deleteOldMeetings(7);
        } catch (error) {
          console.warn('⚠️ Failed to clean up old meetings:', error);
        }
        try {
          await indexedDBService.deleteSavedMeetings(24);
        } catch (error) {
          console.warn('⚠️ Failed to clean up saved meetings:', error);
        }
        await checkForRecoverableTranscripts();
      } catch (error) {
        console.error('Failed to perform startup checks:', error);
      }
    };

    performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  // Watch for recoverable meetings changes and show dialog once per session
  useEffect(() => {
    if (recoverableMeetings.length === 0) {
      setShowRecoveryDialog(false); // нечего восстанавливать - окно не держим открытым
      return;
    }
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
              router.push(`/?id=${result.meetingId}`);
            }
          } : undefined,
          duration: 10000,
        });

        await refetchMeetings();

        if (recoverableMeetings.length === 0) {
          sessionStorage.removeItem('recovery_dialog_shown');
        }

        if (result.meetingId) {
          setTimeout(() => {
            router.push(`/?id=${result.meetingId}`);
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

  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
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

  // «Удалить запись» в окне сохранения: та же реальная остановка, но встреча не сохраняется,
  // папка записи (звук и расшифровка) уходит в удалённые. Geo 02.10: «при сохранении встречи
  // нужно добавить возможность удалить встречу и не сохранять».
  const handleDiscard = async () => {
    setShowSaveModal(false);
    setIsStopping(true);
    try {
      const dataDir = await appDataDir();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await invoke('stop_recording', { args: { save_path: `${dataDir}/recording-${ts}.wav` } });
    } catch (e) {
      console.error('[insapp-meet] discard: ошибка остановки записи', e);
    }
    await handleRecordingStop(false); // без сохранения: дождаться распознавания и вернуться к старту
    await discardCurrentMeeting();
    resetLiveSpeakerNames();
    const folder = sessionStorage.getItem('last_recording_folder_path');
    sessionStorage.removeItem('last_recording_folder_path');
    sessionStorage.removeItem('last_recording_meeting_name');
    try {
      if (folder) await invoke('discard_recording', { folderPath: folder });
      toast.success('Запись удалена', { description: 'Встреча не сохранена' });
    } catch (e) {
      console.error('[insapp-meet] discard: файлы записи не удалились', e);
      toast.error('Встреча не сохранена, но файлы записи остались на диске', { description: String(e) });
    }
  };

  // Старт записи с плашки: мгновенно «Запускаю запись…», ошибки устройства - понятным текстом.
  const startRecording = async () => {
    console.log('[insapp-meet] rec: старт');
    Analytics.trackButtonClick('start_recording', 'recording_controls');
    try {
      await handleRecordingStart();
    } catch (error) {
      const d = describeRecordingStartError(error);
      toast.error(d.title, { description: d.message.replace(/\n/g, ' '), duration: 10000 });
    }
  };

  // Computed values using global status
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;

  const isRecScreen = recordingState.isRecording || devScreen === 'recording';

  const processing = !isRecScreen && [
    RecordingStatus.STOPPING,
    RecordingStatus.PROCESSING_TRANSCRIPTS,
    RecordingStatus.SAVING,
    RecordingStatus.UPLOADING_TO_SERVER,
    RecordingStatus.COMPLETED,
  ].includes(status);

  const clock = useRecordingClock(isRecScreen);
  const paused = clock.paused || recordingState.isPaused;

  // Новая запись: показываем её, тип - «Внутренняя», начало - сейчас.
  useEffect(() => {
    if (isRecScreen) {
      setViewLive(true);
      setLiveType('in');
      setStartedAt(new Date());
    } else {
      setStartedAt(null);
    }
  }, [isRecScreen]);
  // После перезагрузки посреди записи - начало по часам движка.
  useEffect(() => {
    if (!isRecScreen || clock.total <= 0) return;
    const est = Date.now() - clock.total * 1000;
    setStartedAt((prev) => (!prev || Math.abs(prev.getTime() - est) > 5000 ? new Date(est) : prev));
  }, [isRecScreen, clock.total]);

  // Встречу открыли не из списка (всплывашка «Открыть», старая ссылка) во время записи -
  // показываем её; к записи возвращает строка «Идёт запись» в списке.
  const prevIdRef = useRef(idParam);
  useEffect(() => {
    if (idParam && idParam !== prevIdRef.current) setViewLive(false);
    prevIdRef.current = idParam;
  }, [idParam]);

  const sorted = useMemo(
    () => [...((meetings as unknown) as MeetingListItem[])].sort(
      (a, b) => (parseMeetingDate(b)?.getTime() ?? 0) - (parseMeetingDate(a)?.getTime() ?? 0),
    ),
    [meetings],
  );
  const selectedId = idParam || sorted[0]?.id || null;
  const listItem = sorted.find((m) => m.id === selectedId);

  const mode: 'processing' | 'live' | 'meeting' | 'empty' =
    processing ? 'processing' : isRecScreen && viewLive ? 'live' : selectedId ? 'meeting' : 'empty';
  const cols = mode === 'meeting' ? COLS_MEETING : mode === 'live' ? COLS_LIVE : COLS_SINGLE;

  const liveTitle = isAutoMeetingTitle(meetingTitle) ? defaultMeetingName(startedAt ?? new Date()) : meetingTitle;

  const openMeeting = (id: string) => {
    setViewLive(false);
    if (id !== idParam) router.push(`/?id=${encodeURIComponent(id)}`);
  };

  const plate = isRecScreen ? (
    <RecordingPlate
      elapsed={clock.elapsed}
      paused={paused}
      controls={{
        isRecording: recordingState.isRecording,
        onRecordingStop: (callApi = true) => handleRecordingStop(callApi),
        onRecordingStart: handleRecordingStart,
        onTranscriptReceived: () => { },
        onStopInitiated: () => setIsStopping(true),
        onRequestStop: () => setShowSaveModal(true),
        onTranscriptionError: (message) => { showModal('errorAlert', message); },
        isRecordingDisabled,
        isParentProcessing: isProcessingStop,
        selectedDevices,
        meetingName: meetingTitle,
      }}
    />
  ) : (
    <>
      <MicPermissionNote />
      <StartPlate
        onStart={startRecording}
        starting={status === RecordingStatus.STARTING}
        disabled={isRecordingDisabled || processing}
      />
    </>
  );

  return (
    <>
    <div
      className="im-app grid h-screen w-full gap-x-2 overflow-hidden bg-im-bg py-2 pr-2 font-sans text-im-ink antialiased"
      style={{ gridTemplateColumns: cols }}
    >
      <UnifiedSidebar
        meetings={sorted}
        selectedId={mode === 'meeting' ? selectedId : null}
        live={{
          active: isRecScreen,
          selected: mode === 'live',
          title: liveTitle,
          elapsed: clock.elapsed,
          paused,
        }}
        onSelect={openMeeting}
        onSelectLive={() => setViewLive(true)}
        onDeleted={(id) => { if (id === selectedId) router.replace('/'); }}
        plate={plate}
      />

      {mode === 'processing' && <ProcessingSheet status={status} />}
      {mode === 'empty' && <EmptySheet loading={!meetingsLoaded} />}
      {mode === 'live' && (
        <LiveView
          startedAt={startedAt}
          elapsed={clock.elapsed}
          paused={paused}
          meetingType={liveType}
          onMeetingTypeChange={setLiveType}
          isProcessingStop={isProcessingStop}
          isStopping={isStopping}
          meName={me.name}
          meInitials={me.initials}
        />
      )}
      {mode === 'meeting' && selectedId && (
        <MeetingData
          key={selectedId}
          meetingId={selectedId}
          source={source}
          listItem={listItem}
          onMissing={() => router.replace(sorted[0] && sorted[0].id !== selectedId ? `/?id=${sorted[0].id}` : '/')}
          onDeleted={(id) => { if (id === selectedId) router.replace('/'); }}
        />
      )}
    </div>

      {/* All Modals supported */}
      <SettingsModals modals={modals} messages={messages} onClose={hideModal} />

      {/* Recovery Dialog */}
      <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />

      {/* Окно «Сохранить встречу» - открывается по «Стоп», запускает остановку+сохранение */}
      <SaveMeetingModal
        open={showSaveModal}
        defaultName={isAutoMeetingTitle(meetingTitle) ? defaultMeetingName(startedAt ?? new Date()) : meetingTitle}
        defaultType={liveType}
        onCancel={() => setShowSaveModal(false)}
        onConfirm={handleConfirmSave}
        onDiscard={handleDiscard}
      />
    </>
  );
}
