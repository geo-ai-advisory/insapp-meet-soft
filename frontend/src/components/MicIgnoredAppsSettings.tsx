'use client';

import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { MicOff, RotateCcw } from 'lucide-react';

interface MeetingApp {
  bundle_id: string;
  name: string;
}
interface MicSettings {
  enabled: boolean;
  whitelist: MeetingApp[];
  blacklist: MeetingApp[];
}

/**
 * Настройки → Игнорируемые приложения.
 * Список приложений, для которых окно «Начать запись?» отключено навсегда.
 * «Вернуть» убирает приложение из игнора (снова будет предлагать запись).
 */
export function MicIgnoredAppsSettings() {
  const [blacklist, setBlacklist] = useState<MeetingApp[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const s = await invoke<MicSettings>('mic_watcher_get_settings');
      setBlacklist(s?.blacklist ?? []);
    } catch {
      /* mic-watcher только на macOS - на других платформах команды может не быть */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleUnignore = async (app: MeetingApp) => {
    try {
      await invoke('mic_watcher_unignore', { bundleId: app.bundle_id });
      toast.success(`${app.name || app.bundle_id} снова будет предлагать запись`);
      await load();
    } catch {
      toast.error('Не удалось вернуть приложение');
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">Игнорируемые приложения</h3>
        <p className="text-sm text-gray-500 mt-1 leading-relaxed">
          Эти приложения больше не показывают окно «Начать запись?» при включении микрофона.
          Нажми «Вернуть», чтобы снова получать предложение.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Загрузка…</p>
      ) : blacklist.length === 0 ? (
        <div className="text-sm text-gray-400 border border-dashed border-gray-200 rounded-lg p-6 text-center">
          Пока ничего не игнорируется. Нажми «Игнорировать» в окне предложения записи -
          приложение появится здесь.
        </div>
      ) : (
        <ul className="space-y-2">
          {blacklist.map((app) => (
            <li
              key={app.bundle_id}
              className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-gray-200 bg-white"
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-100 text-gray-500 shrink-0">
                  <MicOff className="w-4 h-4 stroke-[1.75]" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 truncate">
                    {app.name || app.bundle_id}
                  </span>
                  <span className="block text-xs text-gray-400 truncate">{app.bundle_id}</span>
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleUnignore(app)}
                className="shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Вернуть
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
