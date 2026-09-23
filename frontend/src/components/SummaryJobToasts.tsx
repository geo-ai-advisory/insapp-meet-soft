'use client';

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { SummaryJobEvent, openClaudeLogin, humanSummaryError } from '@/hooks/useSummaryJobs';

/**
 * Всплывашки фоновых резюме - видны на любом экране приложения.
 *
 * «Готовится» висит, пока Claude пишет резюме (обычно 1-3 минуты), потом на его
 * месте появляется «Готово» с кнопкой «Открыть» или ошибка. Если Claude не
 * авторизован - кнопка «Войти в Claude» открывает окно входа.
 */
export function SummaryJobToasts() {
  const router = useRouter();

  useEffect(() => {
    const un = listen<SummaryJobEvent>('summary-job', (e) => {
      const j = e.payload;
      const id = `summary-job-${j.meeting_id}`;
      const name = j.title ? `«${j.title}»` : 'встречи';
      const onThisMeeting =
        typeof window !== 'undefined' &&
        window.location.pathname.startsWith('/meeting-details') &&
        new URLSearchParams(window.location.search).get('id') === j.meeting_id;

      if (j.state === 'running') {
        toast.loading(`Резюме ${name} готовится`, {
          id,
          description: j.source === 'auto'
            ? 'Встреча закончилась - Claude пишет резюме в фоне, обычно 1-3 минуты'
            : 'Claude пишет резюме в фоне, обычно 1-3 минуты. Можно продолжать работу',
        });
        return;
      }

      if (j.state === 'done') {
        // Статусы «Резюме: есть» на главной и в боковом списке.
        window.dispatchEvent(new CustomEvent('meetings-refresh'));
        toast.success(`Резюме ${name} готово`, {
          id,
          description: onThisMeeting ? 'Уже на экране' : undefined,
          duration: 8000,
          action: onThisMeeting
            ? undefined
            : { label: 'Открыть', onClick: () => router.push(`/meeting-details?id=${j.meeting_id}`) },
        });
        return;
      }

      const err = j.auth_error
        ? { text: 'Claude не авторизован - нужно войти в аккаунт', auth: true }
        : humanSummaryError(j.error);
      toast.error(`Резюме ${name} не получилось`, {
        id,
        description: err.text,
        duration: 15000,
        action: err.auth ? { label: 'Войти в Claude', onClick: () => openClaudeLogin() } : undefined,
      });
    });
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, [router]);

  return null;
}
