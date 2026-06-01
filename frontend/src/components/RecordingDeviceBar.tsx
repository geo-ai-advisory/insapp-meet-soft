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
    setSelectedDevices({
      ...selectedDevices,
      micDevice: value === 'default' ? null : value,
    });
    applyLiveSwitch(value, 'Microphone');
  };

  const systemOn =
    !!selectedDevices.systemDevice && selectedDevices.systemDevice !== '__none__';

  const handleSystemToggle = (on: boolean) => {
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
    <div className="flex items-center gap-3 bg-white rounded-2xl shadow-lg border border-gray-100 px-4 py-2.5">
      {/* Выбор микрофона */}
      <div className="flex items-center gap-2 min-w-0">
        {switching === 'mic' ? (
          <Loader2 className="h-4 w-4 text-blue-600 animate-spin shrink-0" />
        ) : (
          <Mic className="h-4 w-4 text-gray-500 stroke-[1.75] shrink-0" />
        )}
        <Select value={micValue} onValueChange={handleMicChange} disabled={switching !== null}>
          <SelectTrigger
            className="h-8 min-w-[180px] max-w-[240px] border-0 shadow-none bg-transparent px-1.5 text-sm font-medium text-gray-900 focus:ring-0 hover:bg-gray-50 rounded-lg transition-colors"
            aria-label="Выбор микрофона"
          >
            <SelectValue placeholder="Микрофон по умолчанию" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Микрофон по умолчанию</SelectItem>
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
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50 shrink-0"
          aria-label="Обновить список устройств"
          title="Обновить список устройств"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Разделитель */}
      <div className="w-px h-7 bg-gray-200 shrink-0" />

      {/* Тумблер системного звука */}
      <label className="flex items-center gap-2 cursor-pointer select-none shrink-0">
        <Speaker
          className={`h-4 w-4 stroke-[1.75] transition-colors ${
            systemOn ? 'text-gray-700' : 'text-gray-300'
          }`}
        />
        <span
          className={`text-sm font-medium transition-colors ${
            systemOn ? 'text-gray-900' : 'text-gray-400'
          }`}
        >
          Системный звук
        </span>
        <Switch
          checked={systemOn}
          onCheckedChange={handleSystemToggle}
          aria-label="Записывать системный звук"
        />
      </label>
    </div>
  );
}
