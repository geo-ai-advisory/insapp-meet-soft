'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface VoiceRow {
  name: string;
  meetings: number;
  minutes: number;
}

/**
 * Голоса коллег: имя, данное собеседнику в одной встрече, приложение узнаёт по голосу
 * в следующих встречах и подписывает человека само. Здесь - список выученных голосов,
 * «Забыть» и выучивание из прошлых встреч с именами. Голоса хранятся только на этом
 * компьютере и на сервер не отправляются.
 */
export function VoiceProfilesSettings() {
  const [rows, setRows] = useState<VoiceRow[] | null>(null);
  const [learning, setLearning] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await invoke<VoiceRow[]>('voices_list'));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const learn = async () => {
    setLearning(true);
    try {
      const n = await invoke<number>('voices_learn_now');
      toast.success(n > 0 ? `Выучены голоса из встреч: ${n}` : 'Новых встреч с именами нет');
      await load();
    } catch (e) {
      toast.error('Не получилось', { description: String(e) });
    } finally {
      setLearning(false);
    }
  };

  const forget = async (name: string) => {
    setConfirm(null);
    try {
      await invoke('voices_forget', { name });
      toast.success(`Голос «${name}» забыт`, { description: 'Имена в прошлых встречах остались' });
      await load();
    } catch (e) {
      toast.error('Не получилось', { description: String(e) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Назови собеседника один раз - в&nbsp;следующих встречах приложение узнает его по&nbsp;голосу
        и&nbsp;подпишет само. Имя, которое ты дашь вручную, всегда главнее. Голоса хранятся только
        на&nbsp;этом компьютере и&nbsp;на&nbsp;сервер не&nbsp;отправляются.
      </p>

      {rows === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Загружаю голоса...
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          Пока нет ни одного голоса. Назови собеседников во&nbsp;встрече - голоса появятся здесь.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {rows.map((r) => (
            <div key={r.name} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{r.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                встреч: {r.meetings} · {r.minutes} мин речи
              </span>
              {confirm === r.name ? (
                <span className="flex items-center gap-1.5">
                  <button onClick={() => forget(r.name)} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700">
                    Забыть
                  </button>
                  <button onClick={() => setConfirm(null)} className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-secondary">
                    Отмена
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirm(r.name)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                  title="Забыть голос (имена во встречах останутся)"
                  aria-label={`Забыть голос ${r.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          onClick={learn}
          disabled={learning}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3.5 py-2 text-sm text-foreground hover:bg-secondary disabled:opacity-60"
        >
          {learning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Выучить из прошлых встреч
        </button>
      </div>
    </div>
  );
}
