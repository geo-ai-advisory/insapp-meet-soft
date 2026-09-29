import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

/**
 * «Поделиться»: берём у сервера публичную ссылку на встречу и кладём в буфер.
 * Ссылку можно отправить кому угодно - она открывается без пароля.
 * (Логика перенесена без изменений из SummaryPanel.)
 */
export function useShareMeeting(meetingId: string) {
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);

  const share = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const res = await invoke<{ url?: string }>('insapp_share_meeting', { meetingId });
      const url = res?.url;
      if (!url) throw new Error('сервер не вернул ссылку');
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 2500);
      toast.success('Ссылка скопирована', {
        description: 'Откроется у любого, кому её отправишь - пароль не нужен.',
      });
      console.log('[insapp-meet] meet: share link', url);
    } catch (e: any) {
      const msg = typeof e === 'string' ? e : (e?.message || 'не удалось получить ссылку');
      toast.error('Не получилось поделиться', { description: msg });
      console.warn('[insapp-meet] meet: share failed', e);
    } finally {
      setSharing(false);
    }
  }, [meetingId, sharing]);

  return { share, sharing, shared };
}
