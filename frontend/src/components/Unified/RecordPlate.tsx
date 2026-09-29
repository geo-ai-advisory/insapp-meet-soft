'use client';

/**
 * Плашка записи внизу левой панели (эталон b-air, .dock):
 *  - в простое: большая белая «Начать запись · Микрофон <устройство>» с красной круглой кнопкой;
 *  - во время записи: красный таймер, волна, облако (отправка на сервер), микрофон (можно сменить
 *    на лету), звук собеседников и нижний ряд RecordingControls: круглая красная «Стоп» и «Пауза».
 * Красный - только здесь: кнопка записи/стопа, точка и таймер.
 */

import React, { useEffect, useState } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Mic, Volume2, VolumeX, Loader2 } from 'lucide-react';
import { SelectContent, SelectItem } from '@/components/ui/select';
import { RecordingControls } from '@/components/RecordingControls';
import { UploadOptInToggle } from '@/components/UploadOptInToggle';
import { useRecordingDevices } from '@/hooks/useRecordingDevices';
import { formatClock } from '@/lib/meetingFormat';
import { Lvl, RecDot, Wave } from './primitives';

const FAB = 'grid h-12 w-12 flex-none place-items-center rounded-full bg-im-rec text-white shadow-[0_3px_8px_rgba(205,35,20,.35),inset_0_1px_0_rgba(255,255,255,.25)] transition-transform duration-200';

/** «Начать запись» - в простое. */
export function StartPlate({
  onStart, starting, disabled,
}: { onStart: () => void; starting: boolean; disabled: boolean }) {
  const { micName } = useRecordingDevices(false);
  // Выбранный микрофон хранится в localStorage - показываем после монтирования,
  // чтобы не расходиться с заранее собранной страницей.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={disabled || starting}
      aria-label="Начать запись"
      className="group flex h-16 w-full items-center gap-3 rounded-[32px] bg-white pl-2 pr-[18px] text-left shadow-float transition-[border-radius,background] [transition-duration:250ms] hover:bg-im-hover active:rounded-[22px] disabled:cursor-default disabled:hover:bg-white"
    >
      <span className={`${FAB} group-hover:scale-[1.04] group-disabled:scale-100 ${disabled && !starting ? 'opacity-50' : ''}`}>
        {starting ? <Loader2 className="h-[22px] w-[22px] animate-spin" /> : <Mic className="h-[22px] w-[22px]" />}
      </span>
      <span className="min-w-0">
        <b className="block text-[15.5px] font-bold leading-5 tracking-[-0.005em] text-im-ink">
          {starting ? 'Запускаю запись…' : 'Начать запись'}
        </b>
        <small className="mt-px block truncate text-[12px] leading-4 text-im-mut">
          Микрофон {(mounted && micName) || 'по умолчанию'}
        </small>
      </span>
    </button>
  );
}

/** Индикатор микрофона: нажатие - выбрать другой микрофон (переключится на лету). */
function MicIndicator({ isRecording }: { isRecording: boolean }) {
  const { inputDevices, micValue, micName, changeMic, switching } = useRecordingDevices(isRecording);
  return (
    <SelectPrimitive.Root value={micValue} onValueChange={changeMic} disabled={switching !== null}>
      <SelectPrimitive.Trigger
        className="inline-flex min-w-0 items-center gap-[3px] whitespace-nowrap rounded-md hover:text-im-ink2 focus-visible:outline-none"
        title={`Микрофон: ${micName || 'по умолчанию'} - нажмите, чтобы сменить`}
        aria-label={`Микрофон: ${micName || 'по умолчанию'}`}
      >
        {switching === 'mic' ? <Loader2 className="h-3.5 w-3.5 flex-none animate-spin" /> : <Mic className="h-3.5 w-3.5 flex-none" />}
        <span className="max-w-[88px] truncate">{micName || 'Микрофон'}</span>
        <Lvl />
      </SelectPrimitive.Trigger>
      <SelectContent>
        <SelectItem value="default">Микрофон по умолчанию</SelectItem>
        {inputDevices.map((d) => (
          <SelectItem key={d.name} value={`${d.name} (${d.device_type.toLowerCase()})`}>{d.name}</SelectItem>
        ))}
      </SelectContent>
    </SelectPrimitive.Root>
  );
}

/** Звук собеседников (системный звук). Вкл/выкл применится со следующей записи. */
function SystemIndicator({ isRecording }: { isRecording: boolean }) {
  const { systemOn, toggleSystem } = useRecordingDevices(isRecording);
  return (
    <button
      type="button"
      onClick={() => toggleSystem(!systemOn)}
      aria-pressed={systemOn}
      className={`inline-flex flex-none items-center gap-[3px] whitespace-nowrap rounded-md hover:text-im-ink2 ${systemOn ? '' : 'opacity-70'}`}
      title={systemOn ? 'Звук собеседников пишется. Нажмите, чтобы выключить со следующей записи' : 'Звук собеседников не пишется. Нажмите, чтобы включить со следующей записи'}
    >
      {systemOn ? <Volume2 className="h-3.5 w-3.5 flex-none" /> : <VolumeX className="h-3.5 w-3.5 flex-none" />}
      Собеседники
      {systemOn && <Lvl />}
    </button>
  );
}

/** Плашка идущей записи. */
export function RecordingPlate({
  elapsed, paused, controls,
}: {
  elapsed: number;
  paused: boolean;
  /** Пропсы RecordingControls (логика стопа/паузы/ошибок распознавания). */
  controls: Omit<React.ComponentProps<typeof RecordingControls>, 'variant'>;
}) {
  return (
    <div
      className={`flex flex-col rounded-[28px] bg-white pb-2 pl-2 pr-2.5 pt-3 shadow-float ${paused ? 'im-paused' : ''}`}
      role="group"
      aria-label={paused ? 'Запись на паузе' : 'Идёт запись'}
    >
      <div className="flex h-6 items-center gap-[9px] pl-3 pr-1">
        <RecDot />
        <time className="min-w-[44px] text-[17px] font-semibold leading-[22px] text-im-rec-text im-num" aria-label="Длительность записи">
          {formatClock(elapsed)}
        </time>
        {paused && <span className="text-[12.5px] font-semibold text-im-mut">на паузе</span>}
        <span className="flex min-w-0 flex-1 justify-center overflow-hidden">
          {!paused && <Wave w={112} h={12} p={1} amp={2.2} half={4.2} sw={2.4} track={false} className="text-im-data" />}
        </span>
        <UploadOptInToggle visible variant="icon" />
      </div>
      <div className="flex min-w-0 items-center gap-2.5 pb-2.5 pl-3 pr-0 pt-1.5 text-[12px] leading-4 text-im-mut">
        <MicIndicator isRecording />
        <SystemIndicator isRecording />
      </div>
      <RecordingControls {...controls} variant="plate" />
    </div>
  );
}
