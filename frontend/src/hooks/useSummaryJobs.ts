'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';

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

/*
 * Состояние авто-резюме - одно на всё окно (галочка в левой панели, строка на экране записи):
 * раньше у каждого места была своя копия, и до ответа проверки входа в Claude (до 15 с) галочка
 * показывалась снятой, а после переключения в одном месте другое показывало старое.
 * Geo 02.10: «постоянно слетает галочка авто резюме» - в базе она стояла, резюме делались.
 */
let sharedReadiness: SummaryReadiness | null = null;
/** Сохранённая галочка - читается за доли секунды, без проверки входа в Claude. */
let sharedAuto: boolean | null = null;
const readinessListeners = new Set<() => void>();
const publishReadiness = () => readinessListeners.forEach((f) => f());

/** Готовность Claude + переключатель авто-резюме. Обновляется после входа в Claude. */
export function useSummaryReadiness() {
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  const refresh = useCallback(async () => {
    try {
      const r = await invoke<SummaryReadiness>('ai_summary_status');
      sharedReadiness = r;
      sharedAuto = r.auto_summary;
      publishReadiness();
    } catch {
      /* не прочиталось - оставляем последнее известное состояние, а не «выключено» */
    }
  }, []);

  useEffect(() => {
    readinessListeners.add(rerender);
    if (sharedAuto === null) {
      invoke<{ auto_summary?: boolean }>('ai_summary_get_settings')
        .then((s) => {
          if (sharedAuto === null && s) {
            sharedAuto = !!s.auto_summary;
            publishReadiness();
          }
        })
        .catch(() => {});
    }
    refresh();
    const onChange = () => { refresh(); };
    window.addEventListener('claude-login-changed', onChange);
    return () => {
      readinessListeners.delete(rerender);
      window.removeEventListener('claude-login-changed', onChange);
    };
  }, [refresh]);

  const setAuto = useCallback(async (enabled: boolean) => {
    const r = await invoke<SummaryReadiness>('ai_summary_set_auto', { enabled });
    sharedReadiness = r;
    sharedAuto = r.auto_summary;
    publishReadiness();
    return r;
  }, []);

  return { readiness: sharedReadiness, autoSaved: sharedAuto, refresh, setAuto };
}

/**
 * Галочка «Авто-резюме после встречи»: состояние, подсказка и действие.
 *
 * Включается только когда подключён Claude: выбран в настройках AI-резюме,
 * установлен на компьютере и выполнен вход в аккаунт. Иначе - подсказка, что сделать,
 * и действие («Войти в Claude» / «Настройки»). Если галочка уже включена, а вход в Claude
 * слетел - предупреждение: резюме не создадутся, пока не войдёшь.
 * (Логика перенесена без изменений из AutoSummaryToggle старой главной.)
 */
export function useAutoSummaryState(onOpenSettings: () => void) {
  const { readiness, autoSaved, setAuto } = useSummaryReadiness();
  const [saving, setSaving] = useState(false);

  const checking = readiness === null;
  // Пока проверяется вход в Claude, галочка - как сохранена (не «снята»).
  const on = readiness ? readiness.auto_summary : !!autoSaved;
  const ready = !!readiness?.claude_ready;

  let hint = '';
  let warn = false;
  let action: { label: string; run: () => void } | null = null;
  if (checking) {
    hint = 'Проверяю подключение Claude...';
  } else if (readiness!.provider !== 'claude') {
    hint = 'Работает только с Claude - выбери его в настройках AI-резюме';
    action = { label: 'Настройки', run: onOpenSettings };
  } else if (!readiness!.cli_path) {
    hint = 'Claude не найден на этом компьютере - проверь настройки AI-резюме';
    action = { label: 'Настройки', run: onOpenSettings };
  } else if (!ready) {
    hint = on
      ? 'Включено, но вход в Claude истёк - резюме не создадутся, пока не войдёшь'
      : 'Нужно войти в свой аккаунт Claude';
    warn = on;
    action = { label: 'Войти в Claude', run: () => openClaudeLogin() };
  } else {
    hint = on
      ? 'Claude Sonnet напишет резюме в фоне сразу после окончания встречи'
      : 'Резюме будет появляться само после каждой встречи - Claude Sonnet, в фоне';
  }

  // Включить можно только при готовом Claude; выключить - всегда (и пока идёт проверка входа).
  const canToggle = !saving && (on || (!checking && ready));

  const toggle = useCallback(async () => {
    if (!canToggle) {
      if (action) action.run();
      return;
    }
    setSaving(true);
    try {
      const r = await setAuto(!on);
      toast.success(r.auto_summary ? 'Авто-резюме включено' : 'Авто-резюме выключено', {
        description: r.auto_summary ? 'После каждой встречи Claude Sonnet сделает резюме в фоне' : undefined,
      });
    } catch (e) {
      toast.error('Не удалось сохранить', { description: String(e) });
    } finally {
      setSaving(false);
    }
  }, [canToggle, action, setAuto, on]);

  return { checking, on, ready, hint, warn, action, canToggle, saving, toggle, model: readiness?.model };
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
