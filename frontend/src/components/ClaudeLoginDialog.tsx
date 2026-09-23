'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Loader2, X, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import '@xterm/xterm/css/xterm.css';
import type { SummaryReadiness } from '@/hooks/useSummaryJobs';

/**
 * Вход в Claude для фоновых резюме.
 *
 * Фоновые резюме делает программа Claude на компьютере пользователя, и её вход
 * время от времени истекает («OAuth session expired»). Тогда резюме молча не
 * создаются. Это окно запускает вход: открывается браузер, пользователь входит
 * в свой аккаунт, окно само замечает успешный вход и закрывается. Встроенный
 * терминал нужен на случай, если браузер покажет код, который надо вставить.
 *
 * Открывается событием окна `open-claude-login` из любого места приложения.
 */
export function ClaudeLoginDialog() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOpen = () => { setDone(false); setProblem(null); setOpen(true); };
    window.addEventListener('open-claude-login', onOpen);
    return () => window.removeEventListener('open-claude-login', onOpen);
  }, []);

  useEffect(() => {
    if (!open || !boxRef.current) return;
    let session: string | null = null;
    let unOut: UnlistenFn | null = null;
    let unExit: UnlistenFn | null = null;
    let alive = true;

    const term = new XTerm({
      fontFamily: "'SF Mono', 'Menlo', monospace",
      fontSize: 12,
      convertEol: true,
      cursorBlink: true,
      theme: { background: '#f5f5f7', foreground: '#1d1d1f', cursor: '#1d1d1f' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current);
    fit.fit();

    const start = async () => {
      const r = await invoke<SummaryReadiness>('ai_summary_status').catch(() => null);
      if (!alive) return;
      if (!r?.cli_path) {
        setProblem('Программа Claude не найдена на компьютере. Установи Claude Code и попробуй снова.');
        return;
      }
      if (r.logged_in) { setDone(true); return; }
      try {
        session = await invoke<string>('pty_spawn', {
          request: { command: r.cli_path, args: ['auth', 'login'], cwd: null, cols: term.cols, rows: term.rows, env: {} },
        });
        unOut = await listen<string>(`pty-output-${session}`, (e) => term.write(e.payload));
        unExit = await listen(`pty-exit-${session}`, () => { session = null; });
        term.onData((d) => { if (session) invoke('pty_write', { sessionId: session, data: d }).catch(() => {}); });
      } catch (e: any) {
        setProblem(typeof e === 'string' ? e : e?.message || 'Не удалось запустить вход');
      }
    };
    start();

    // Ждём входа: проверка локальная и бесплатная, раз в 2 секунды.
    const poll = setInterval(async () => {
      const r = await invoke<SummaryReadiness>('ai_summary_status').catch(() => null);
      if (alive && r?.logged_in) {
        setDone(true);
        clearInterval(poll);
      }
    }, 2000);

    return () => {
      alive = false;
      clearInterval(poll);
      unOut?.();
      unExit?.();
      if (session) invoke('pty_kill', { sessionId: session }).catch(() => {});
      term.dispose();
    };
  }, [open]);

  useEffect(() => {
    if (!done) return;
    toast.success('Claude подключён', { description: 'Резюме будут создаваться в фоне' });
    window.dispatchEvent(new CustomEvent('claude-login-changed'));
    const t = setTimeout(() => setOpen(false), 900);
    return () => clearTimeout(t);
  }, [done]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-foreground">Вход в Claude</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Сейчас откроется браузер - войди в свой аккаунт Claude. Если браузер покажет код,
              вставь его в окно ниже и нажми Enter.
            </p>
          </div>
          <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label="Закрыть">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          {problem ? (
            <p className="text-[13px] text-red-600">{problem}</p>
          ) : (
            <div ref={boxRef} className="h-[220px] overflow-hidden rounded-lg border border-border bg-[#f5f5f7] p-2" />
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-5 py-3.5 text-[12.5px]">
          {done ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600"><CheckCircle2 className="h-4 w-4" /> Вход выполнен</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Жду входа в браузере...</span>
          )}
          <button onClick={() => setOpen(false)} className="rounded-lg border border-border px-3.5 py-2 text-[13px] text-foreground hover:bg-secondary">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
