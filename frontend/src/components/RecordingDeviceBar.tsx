'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Mic, Speaker, RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/contexts/ConfigContext';

interface AudioDevice {
  name: string;
  device_type: 'Input' | 'Output';
}

/** Убирает суффикс " (input)"/" (output)" - backend reconnect ждёт чистое имя. */
function cleanDeviceName(value: string): string {
  return value.replace(/\s*\((input|output)\)\s*$/i, '');
}

/**
 * Компактная панель выбора аудио-устройств над кнопкой записи.
 *
 * Показывается ВСЕГДА - и до старта записи, и во время неё:
 *  - до старта: выбор просто сохраняется и применяется при старте;
 *  - во время записи: смена устройства применяется на лету (через
 *    attempt_device_reconnect - останавливает старый поток и запускает новый,
 *    не прерывая запись). Нужно если, например, наушники отвалились.
 *
 * Системный звук включён по умолчанию (тумблер ON → systemDevice "__default__").
 */
export function RecordingDeviceBar({ isRecording = false }: { isRecording?: boolean }) {
  const { selectedDevices, setSelectedDevices } = useConfig();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState<null | 'mic' | 'system'>(null);

  const inputDevices = devices.filter((d) => d.device_type === 'Input');

  const fetchDevices = async () => {
    try {
      const result = await invoke<AudioDevice[]>('get_audio_devices');
      setDevices(result);
    } catch (err) {
      console.error('Не удалось получить список аудио-устройств:', err);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchDevices();
  };

  const micValue = selectedDevices.micDevice || 'default';

  // Применить смену устройства на лету (только во время записи).
  const applyLiveSwitch = async (deviceValue: string, kind: 'Microphone' | 'SystemAudio') => {
    if (!isRecording || deviceValue === 'default') return;
    const name = cleanDeviceName(deviceValue);
    setSwitching(kind === 'Microphone' ? 'mic' : 'system');
    try {
      const ok = await invoke<boolean>('attempt_device_reconnect', {
        deviceName: name,
        deviceType: kind,
      });
      if (ok) {
        toast.success(
          kind === 'Microphone' ? `Микрофон переключён: ${name}` : `Системный звук: ${name}`,
        );
      } else {
        toast.error(`Не удалось переключиться на «${name}» - устройство недоступно`);
      }
    } catch (e) {
      toast.error(`Ошибка переключения: ${typeof e === 'string' ? e : 'устройство недоступно'}`);
    } finally {
      setSwitching(null);
    }
  };

  const handleMicChange = (value: string) => {
    console.log(`[insapp-meet] rec: смена устройства (микрофон) -> ${value === 'default' ? 'по умолчанию' : cleanDeviceName(value)}`);
    setSelectedDevices({
      ...selectedDevices,
      micDevice: value === 'default' ? null : value,
    });
    applyLiveSwitch(value, 'Microphone');
  };

  const systemOn =
    !!selectedDevices.systemDevice && selectedDevices.systemDevice !== '__none__';

  const handleSystemToggle = (on: boolean) => {
    console.log(`[insapp-meet] rec: системный звук ${on ? 'вкл' : 'выкл'}`);
    setSelectedDevices({
      ...selectedDevices,
      systemDevice: on ? '__default__' : null,
    });
    // Во время записи мгновенное вкл/выкл системного звука пока не делаем
    // (требует остановки/старта system-потока) - применится со следующей записи.
    if (isRecording) {
      toast.info(
        on
          ? 'Системный звук включится при следующей записи'
          : 'Системный звук выключится при следующей записи',
      );
    }
  };

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
