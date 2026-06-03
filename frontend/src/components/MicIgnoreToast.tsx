'use client';

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';

/**
 * Тост в главном окне после нажатия «Игнорировать» в окне-попапе микрофона.
 * Backend (meeting_popup_dismiss) шлёт событие mic-app-ignored.
 */
export function MicIgnoreToast() {
  useEffect(() => {
    const unlisten = listen<{ name: string; bundle_id: string }>('mic-app-ignored', (e) => {
      const name = e.payload?.name || e.payload?.bundle_id || 'Приложение';
      toast.success(`${name} добавлено в игнорируемые`, {
        description: 'Вернуть можно в Настройках → Игнор микрофона',
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  return null;
}
