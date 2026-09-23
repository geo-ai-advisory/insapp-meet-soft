'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Событие фонового резюме (бэкенд шлёт `summary-job`). */
export interface SummaryJobEvent {
  meeting_id: string;
  title: string;
  state: 'running' | 'done' | 'error';
  source: 'manual' | 'auto';
  started_ms: number;
  error?: string | null;
  auth_error: boolean;
}

/** Готовность фоновых резюме через Claude. */
export interface SummaryReadiness {
  provider: string;
  cli_path: string | null;
  logged_in: boolean | null;
  claude_ready: boolean;
  auto_summary: boolean;
  model: string;
}

/**
 * Какие встречи сейчас получают резюме в фоне: id -> момент старта (мс).
 *
 * Состояние живёт в бэкенде, здесь - только подписка: так страница, открытая
 * посреди генерации (например, сразу после окончания записи с авто-резюме),
 * сразу показывает «готовится», а не «резюме ещё нет».
 */
export function useSummaryJobs(): Record<string, number> {
  const [jobs, setJobs] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    invoke<{ meeting_id: string; started_ms: number }[]>('ai_summary_jobs')
      .then((list) => {
        if (!alive) return;
        const m: Record<string, number> = {};
        (list || []).forEach((j) => { m[j.meeting_id] = j.started_ms; });
        setJobs(m);
      })
      .catch(() => {});

    const un = listen<SummaryJobEvent>('summary-job', (e) => {
      const j = e.payload;
      setJobs((prev) => {
        const next = { ...prev };
        if (j.state === 'running') next[j.meeting_id] = j.started_ms;
        else delete next[j.meeting_id];
        return next;
      });
    });
    return () => {
      alive = false;
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  return jobs;
}

/** Секунды с момента старта - для надписи «готовится 0:42». Тикает раз в секунду. */
export function useElapsed(startedMs: number | undefined): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedMs) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedMs]);
  if (!startedMs) return '';
  const s = Math.max(0, Math.floor((now - startedMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Готовность Claude + переключатель авто-резюме. Обновляется после входа в Claude. */
export function useSummaryReadiness() {
  const [readiness, setReadiness] = useState<SummaryReadiness | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReadiness(await invoke<SummaryReadiness>('ai_summary_status'));
    } catch {
      /* статус не критичен - просто не показываем галочку */
    }
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => { refresh(); };
    window.addEventListener('claude-login-changed', onChange);
    return () => window.removeEventListener('claude-login-changed', onChange);
  }, [refresh]);

  const setAuto = useCallback(async (enabled: boolean) => {
    const r = await invoke<SummaryReadiness>('ai_summary_set_auto', { enabled });
    setReadiness(r);
    return r;
  }, []);

  return { readiness, refresh, setAuto };
}

/** Открыть окно входа в Claude (оно подключено в корне приложения). */
export function openClaudeLogin() {
  window.dispatchEvent(new CustomEvent('open-claude-login'));
}

/** Текст ошибки для людей (без технических деталей). */
export function humanSummaryError(e: unknown): { text: string; auth: boolean } {
  const msg = typeof e === 'string' ? e : (e as any)?.message || String(e ?? '');
  if (msg.startsWith('AUTH:')) {
    return { text: 'Claude не авторизован - нужно войти в аккаунт', auth: true };
  }
  if (msg.includes('уже готовится')) return { text: 'Резюме этой встречи уже готовится', auth: false };
  if (msg.includes('12 минут')) return { text: 'Слишком долго - попробуй ещё раз', auth: false };
  if (msg.includes('Не найден инструмент')) return { text: 'Claude не установлен или не настроен', auth: false };
  return { text: msg.slice(0, 160) || 'Не получилось сделать резюме', auth: false };
}
