'use client';
// УСТАРЕЛО (29.09.2026): файл больше не подключён - главный экран теперь components/Unified/*
// (см. design-2026-09-29/impl/CHANGES.md). Не править; удалить отдельной чисткой.

import { Mic, Speaker, RefreshCw, Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useRecordingDevices } from '@/hooks/useRecordingDevices';

/**
 * Компактная панель выбора аудио-устройств (старый нижний док записи).
 * Вся логика - в хуке useRecordingDevices (им же пользуется плашка записи главного экрана).
 */
export function RecordingDeviceBar({ isRecording = false }: { isRecording?: boolean }) {
  const {
    inputDevices, micValue, changeMic: handleMicChange, systemOn, toggleSystem: handleSystemToggle,
    refresh: handleRefresh, refreshing, switching,
  } = useRecordingDevices(isRecording);

  return (
    <div className="flex items-center gap-3">
      {/* Выбор микрофона - плоский inline-селект с тонкой рамкой (как в макете «нижний док») */}
      <div className="flex items-center gap-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0 rounded-lg border border-border bg-card px-2.5 py-1.5 transition-colors hover:bg-secondary focus-within:border-primary">
          {switching === 'mic' ? (
            <Loader2 className="h-[15px] w-[15px] text-primary animate-spin shrink-0" />
          ) : (
            <Mic className="h-[15px] w-[15px] text-muted-foreground stroke-[1.75] shrink-0" />
          )}
          <Select value={micValue} onValueChange={handleMicChange} disabled={switching !== null}>
            <SelectTrigger
              className="h-6 min-w-[80px] max-w-[150px] border-0 shadow-none bg-transparent px-0 text-[13px] font-medium text-foreground focus:ring-0 hover:bg-transparent"
              aria-label="Выбор микрофона"
            >
              <SelectValue placeholder="Микрофон" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Микрофон</SelectItem>
              {inputDevices.map((device) => (
                <SelectItem
                  key={device.name}
                  value={`${device.name} (${device.device_type.toLowerCase()})`}
                >
                  {device.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50 shrink-0"
          aria-label="Обновить список устройств"
          title="Обновить список устройств"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Системный звук - только иконка + рубильник (компактно), текст в подсказке */}
      <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0" title="Системный звук">
        <Speaker
          className={`h-4 w-4 stroke-[1.75] transition-colors ${
            systemOn ? 'text-foreground' : 'text-muted-foreground'
          }`}
        />
        <Switch
          checked={systemOn}
          onCheckedChange={handleSystemToggle}
          aria-label="Системный звук"
        />
      </label>
    </div>
  );
}
