'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';

export interface AudioDevice {
  name: string;
  device_type: 'Input' | 'Output';
}

/** Убирает суффикс " (input)"/" (output)" - backend reconnect ждёт чистое имя. */
export function cleanDeviceName(value: string): string {
  return value.replace(/\s*\((input|output)\)\s*$/i, '');
}

/**
 * Аудио-устройства записи: список микрофонов, смена микрофона на лету и звук собеседников.
 *
 *  - до старта: выбор просто сохраняется и применяется при старте;
 *  - во время записи: смена микрофона применяется сразу (attempt_device_reconnect -
 *    останавливает старый поток и запускает новый, не прерывая запись);
 *  - звук собеседников (системный звук) включён по умолчанию (systemDevice "__default__"),
 *    вкл/выкл во время записи применится со следующей записи.
 *
 * Логика перенесена без изменений из RecordingDeviceBar.
 */
export function useRecordingDevices(isRecording: boolean) {
  const { selectedDevices, setSelectedDevices } = useConfig();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState<null | 'mic' | 'system'>(null);

  const inputDevices = devices.filter((d) => d.device_type === 'Input');

  const fetchDevices = useCallback(async () => {
    try {
      const result = await invoke<AudioDevice[]>('get_audio_devices');
      setDevices(Array.isArray(result) ? result : []);
    } catch (err) {
      console.error('Не удалось получить список аудио-устройств:', err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    fetchDevices();
  }, [fetchDevices]);

  const micValue = selectedDevices.micDevice || 'default';
  /** Имя микрофона для подписи: «AirPods Pro» или «по умолчанию». */
  const micName = selectedDevices.micDevice ? cleanDeviceName(selectedDevices.micDevice) : '';

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

  const changeMic = (value: string) => {
    console.log(`[insapp-meet] rec: смена устройства (микрофон) -> ${value === 'default' ? 'по умолчанию' : cleanDeviceName(value)}`);
    setSelectedDevices({
      ...selectedDevices,
      micDevice: value === 'default' ? null : value,
    });
    applyLiveSwitch(value, 'Microphone');
  };

  const systemOn =
    !!selectedDevices.systemDevice && selectedDevices.systemDevice !== '__none__';

  const toggleSystem = (on: boolean) => {
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

  return {
    inputDevices,
    micValue,
    micName,
    changeMic,
    systemOn,
    toggleSystem,
    refresh,
    refreshing,
    switching,
  };
}
