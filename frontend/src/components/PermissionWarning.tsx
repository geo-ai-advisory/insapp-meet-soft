import React from 'react';
import { AlertTriangle, Mic, Speaker, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { invoke } from '@tauri-apps/api/core';
import { useIsLinux } from '@/hooks/usePlatform';

interface PermissionWarningProps {
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
  onRecheck: () => void;
  isRechecking?: boolean;
}

export function PermissionWarning({
  hasMicrophone,
  hasSystemAudio,
  onRecheck,
  isRechecking = false
}: PermissionWarningProps) {
  const isLinux = useIsLinux();

  // Don't show on Linux - permission handling is not needed
  if (isLinux) {
    return null;
  }

  // Don't show if both permissions are granted
  if (hasMicrophone && hasSystemAudio) {
    return null;
  }

  const isMacOS = navigator.userAgent.includes('Mac');

  const openMicrophoneSettings = async () => {
    if (isMacOS) {
      try {
        await invoke('open_system_settings', { preferencePane: 'Privacy_Microphone' });
      } catch (error) {
        console.error('Failed to open microphone settings:', error);
      }
    }
  };

  const openScreenRecordingSettings = async () => {
    if (isMacOS) {
      try {
        await invoke('open_system_settings', { preferencePane: 'Privacy_ScreenCapture' });
      } catch (error) {
        console.error('Failed to open screen recording settings:', error);
      }
    }
  };

  return (
    <div className="mx-auto mb-4 max-w-2xl rounded-2xl border border-border bg-secondary px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
          <AlertTriangle className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            {!hasMicrophone && !hasSystemAudio
              ? 'Нужен доступ к звуку'
              : !hasMicrophone
                ? 'Нужен доступ к микрофону'
                : 'Нужен доступ к системному звуку'}
          </h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {!hasMicrophone
              ? 'Чтобы записывать встречи, разреши Insapp-meet доступ к микрофону в системных настройках.'
              : 'Чтобы записать звук собеседников, разреши запись экрана. Иначе в запись попадёт только твой микрофон.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {isMacOS && !hasMicrophone && (
              <button
                onClick={openMicrophoneSettings}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-[filter] hover:brightness-105"
              >
                <Mic className="h-4 w-4" />
                Настройки микрофона
              </button>
            )}
            {isMacOS && !hasSystemAudio && (
              <button
                onClick={openScreenRecordingSettings}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-secondary"
              >
                <Speaker className="h-4 w-4" />
                Запись экрана
              </button>
            )}
            <button
              onClick={onRecheck}
              disabled={isRechecking}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isRechecking ? 'animate-spin' : ''}`} />
              Проверить ещё раз
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
