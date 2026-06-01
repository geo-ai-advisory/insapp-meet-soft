"use client";

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  Loader2,
  Sparkles,
  Copy,
  RefreshCw,
  ChevronDown,
  X,
  Save,
  Cloud,
  CloudOff,
  CheckCircle2,
} from "lucide-react";
import { Button } from "./ui/button";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";

interface TerminalPanelProps {
  meetingId: string;
  meetingTitle: string;
  /** Свернуть панель (state процесса сохраняется). */
  onMinimize: () => void;
  /** Закрыть полностью (убивает pty-процесс). */
  onClose: () => void;
  onSummarySaved: (markdown: string) => void;
  /** Был ли транскрипт встречи отправлен на сервер при записи (для подсказки в UI) */
  wasUploadedToServer?: boolean;
}

/**
 * Встроенный TUI claude для AI-резюме.
 *
 * Архитектура:
 * - claude запускается в интерактивном TUI - пользователь видит ответ AI как в обычном Claude Code
 * - Начальный промпт вводится автоматом через pty_write (bracketed paste)
 * - Пользователь может править в чате ("сократи", "добавь раздел Х")
 * - По кнопке "Сохранить как резюме" backend через pty шлёт AI команду
 *   "запиши финальную версию в файл" - AI пишет файл, backend читает и сохраняет
 *
 * Никакого парсинга буфера терминала. Файл = единственный источник истины.
 * Файл создаётся ПО ЗАПРОСУ пользователя (нажатие Save), а не сразу.
 */
export function TerminalPanel({
  meetingId,
  meetingTitle,
  onMinimize,
  onClose,
  onSummarySaved,
  wasUploadedToServer = true,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Активна ли pty-сессия (можно ли отправлять save-команду)
  const [sessionActive, setSessionActive] = useState(false);

  const [isStarting, setIsStarting] = useState(true);
  const [isFinished, setIsFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSavedLocally, setIsSavedLocally] = useState(false);
  // Статус отправки резюме на сервер: idle | sending | sent | failed | disabled
  const [serverStatus, setServerStatus] = useState<
    "idle" | "sending" | "sent" | "failed" | "disabled"
  >("idle");
  const [isSaving, setIsSaving] = useState(false);
  const [savedMarkdown, setSavedMarkdown] = useState<string | null>(null);
  // Готов ли файл резюме (AI его записал) - тогда Save активен даже если процесс завершился
  const [fileReady, setFileReady] = useState(false);

  // Периодически проверяем появился ли файл резюме (AI пишет его в процессе).
  // Как только появился - активируем кнопку Save независимо от состояния сессии.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const md = await invoke<string | null>("ai_summary_read_file", { meetingId });
        if (alive && md && md.trim().length > 30) setFileReady(true);
      } catch (_) { /* нет файла */ }
    };
    check();
    const interval = setInterval(check, 2000);
    return () => { alive = false; clearInterval(interval); };
  }, [meetingId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Apple Color Emoji', 'Lucida Grande', monospace",
      fontSize: 12,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#f5f5f7",
        foreground: "#1d1d1f",
        cursor: "#1d1d1f",
        cursorAccent: "#f5f5f7",
        selectionBackground: "#b4d5fe",
        black: "#1d1d1f",
        red: "#c0392b",
        green: "#27ae60",
        yellow: "#d68910",
        blue: "#2874a6",
        magenta: "#8e44ad",
        cyan: "#1abc9c",
        white: "#bdc3c7",
        brightBlack: "#7f8c8d",
        brightRed: "#e74c3c",
        brightGreen: "#2ecc71",
        brightYellow: "#f1c40f",
        brightBlue: "#3498db",
        brightMagenta: "#9b59b6",
        brightCyan: "#1abc9c",
        brightWhite: "#ecf0f1",
      },
      convertEol: true,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    let outputUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const start = async () => {
      try {
        const result = await invoke<{
          session_id: string;
          command: string;
          args: string[];
        }>("ai_summary_start", {
          meetingId,
          cols: term.cols,
          rows: term.rows,
        });

        sessionIdRef.current = result.session_id;
        setSessionActive(true);
        term.writeln(
          `\x1b[34m▶ Запускаю ${result.command} ${result.args.join(" ")}\x1b[0m`,
        );
        term.writeln("\x1b[90m(подожди ~3 сек, промпт введётся автоматом)\x1b[0m");
        term.writeln("");
        setIsStarting(false);

        outputUnlisten = await listen<string>(
          `pty-output-${result.session_id}`,
          (e) => {
            term.write(e.payload);
          },
        );

        exitUnlisten = await listen(`pty-exit-${result.session_id}`, async () => {
          term.writeln("");
          term.writeln("\x1b[33m▶ Процесс завершён - можно перезапустить\x1b[0m");
          setSessionActive(false);
          setIsFinished(true);
        });

        term.onData((data) => {
          if (sessionIdRef.current) {
            invoke("pty_write", {
              sessionId: sessionIdRef.current,
              data,
            }).catch(console.error);
          }
        });

        resizeObserver = new ResizeObserver(() => {
          fit.fit();
          if (sessionIdRef.current) {
            invoke("pty_resize", {
              sessionId: sessionIdRef.current,
              cols: term.cols,
              rows: term.rows,
            }).catch(console.error);
          }
        });
        if (containerRef.current) {
          resizeObserver.observe(containerRef.current);
        }
      } catch (e: any) {
        const msg = typeof e === "string" ? e : e?.message || JSON.stringify(e);
        setError(msg);
        setIsStarting(false);
        term.writeln(`\x1b[31m✗ Ошибка: ${msg}\x1b[0m`);
      }
    };

    start();

    return () => {
      if (outputUnlisten) outputUnlisten();
      if (exitUnlisten) exitUnlisten();
      if (resizeObserver) resizeObserver.disconnect();
      if (sessionIdRef.current) {
        invoke("pty_kill", { sessionId: sessionIdRef.current }).catch(() => {});
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  /**
   * Save flow (надёжный, без гонки с занятым AI):
   * 1. Сначала читаем УЖЕ записанный AI файл (ai_summary_read_file).
   *    AI пишет файл в процессе работы - в большинстве случаев он уже на диске.
   * 2. Если файла ещё нет - просим AI записать (ai_summary_request_save) и ждём.
   * 3. Frontend → ai_summary_save_result → БД + сервер.
   * 4. onSummarySaved(markdown) → page.tsx обновляет окно митинга.
   *
   * Раньше Save ВСЕГДА слал AI новую команду + polling 60 сек. Если AI был занят
   * (думал над правкой пользователя дольше) - polling истекал, сохранение падало,
   * хотя файл уже был записан. Теперь читаем готовый файл напрямую.
   */
  const handleSaveAsSummary = async () => {
    setIsSaving(true);
    try {
      // Шаг 1: пробуем прочитать уже записанный файл
      let markdown = "";
      try {
        const existing = await invoke<string | null>("ai_summary_read_file", { meetingId });
        if (existing && existing.trim().length > 30) {
          markdown = existing;
        }
      } catch (_) { /* файла нет - попросим AI ниже */ }

      // Шаг 2: если файла нет - просим AI записать (нужна активная сессия)
      if (!markdown) {
        if (!sessionIdRef.current || !sessionActive) {
          toast.error("Резюме ещё не готово. Дождись пока AI закончит, потом сохрани.");
          setIsSaving(false);
          return;
        }
        toast.loading("Прошу AI записать финальную версию...", { id: "save-summary" });
        markdown = await invoke<string>("ai_summary_request_save", {
          sessionId: sessionIdRef.current,
          meetingId,
        });
      }

      // Шаг 3: пишем в БД и отправляем на сервер
      const result = await invoke<{ saved: boolean; sync_status: string }>(
        "ai_summary_save_result",
        {
          meetingId,
          summaryMarkdown: markdown,
        },
      );

      setSavedMarkdown(markdown);
      setIsSavedLocally(true);

      if (result.sync_status === "sent") {
        setServerStatus("sent");
        toast.success("Резюме сохранено и отправлено на сервер", { id: "save-summary" });
      } else if (result.sync_status === "pending") {
        setServerStatus("idle");
        toast.success("Резюме сохранено. Сервер недоступен — отправится позже", { id: "save-summary" });
      } else if (result.sync_status === "disabled") {
        setServerStatus("disabled");
        toast.success("Резюме сохранено локально", { id: "save-summary" });
      } else {
        setServerStatus("idle");
        toast.success("Резюме сохранено", { id: "save-summary" });
      }

      // Триггерим обновление окна митинга
      onSummarySaved(markdown);
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as any)?.message || String(e);
      toast.error("Не удалось сохранить", {
        id: "save-summary",
        description: msg,
      });
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Отдельная "Отправить на сервер" - если auto upload был выключен и пользователь
   * хочет переотправить уже сохранённое резюме на сервер.
   */
  const handleSendToServer = async () => {
    if (!savedMarkdown) {
      toast.error("Сначала нажми «Сохранить как резюме»");
      return;
    }
    setIsSaving(true);
    setServerStatus("sending");
    try {
      const result = await invoke<{ sync_status: string }>(
        "ai_summary_resend_to_server",
        { meetingId },
      );
      if (result.sync_status === "sent") {
        setServerStatus("sent");
        toast.success("Резюме отправлено на сервер");
      } else if (result.sync_status === "pending") {
        setServerStatus("idle");
        toast.warning("Сервер недоступен — резюме в очереди, отправится позже");
      } else if (result.sync_status === "disabled") {
        setServerStatus("disabled");
        toast.error("Авто-отправка выключена. Включи в «Настройки → Сервер Insapp».");
      } else {
        setServerStatus("failed");
        toast.error("Не удалось отправить резюме");
      }
    } catch (e) {
      setServerStatus("failed");
      toast.error("Не удалось отправить", { description: String(e) });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!savedMarkdown) {
      toast.error("Сначала сохрани резюме");
      return;
    }
    try {
      await navigator.clipboard.writeText(savedMarkdown);
      toast.success("Резюме скопировано");
    } catch (_) {
      toast.error("Не удалось скопировать");
    }
  };

  const handleRestart = async () => {
    if (!confirm("Перезапустить процесс AI-резюме? Текущий диалог пропадёт.")) {
      return;
    }
    if (sessionIdRef.current) {
      await invoke("pty_kill", { sessionId: sessionIdRef.current }).catch(() => {});
    }
    if (termRef.current) termRef.current.clear();
    setIsFinished(false);
    setIsStarting(true);
    setIsSavedLocally(false);
    setSavedMarkdown(null);
    setServerStatus("idle");
    setSessionActive(false);
    setError(null);
    try {
      const result = await invoke<{ session_id: string }>("ai_summary_start", {
        meetingId,
        cols: termRef.current?.cols ?? 80,
        rows: termRef.current?.rows ?? 24,
      });
      sessionIdRef.current = result.session_id;
      setSessionActive(true);
      setIsStarting(false);
    } catch (e) {
      setError(String(e));
      setIsStarting(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white text-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between min-h-[64px] px-4 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-blue-600 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-900">AI-резюме</span>
          {isStarting && (
            <Loader2 className="w-3 h-3 animate-spin text-gray-400 flex-shrink-0" />
          )}
          {!isStarting && (
            <span
              className="ml-3 text-xs text-gray-500 truncate"
              title={
                wasUploadedToServer
                  ? "Транскрипт встречи уже на сервере"
                  : "Транскрипт встречи НЕ отправлялся на сервер"
              }
            >
              {wasUploadedToServer ? (
                <span className="flex items-center gap-1">
                  <Cloud className="w-3 h-3 text-green-600" />
                  Транскрипт на сервере
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <CloudOff className="w-3 h-3 text-gray-400" />
                  Транскрипт не отправлялся
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={onMinimize}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 text-sm font-medium text-gray-600 hover:bg-gray-200 hover:text-gray-900 rounded-md transition-colors"
            aria-label="Свернуть"
            title="Свернуть - процесс продолжит работу, вернуться можно по кнопке внизу справа"
          >
            <ChevronDown className="w-4 h-4 stroke-[1.75]" />
            Свернуть
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-8 w-8 text-gray-500 hover:bg-gray-200 hover:text-gray-900 rounded-md transition-colors"
            aria-label="Закрыть"
            title="Закрыть - процесс AI-резюме будет остановлен"
          >
            <X className="w-4 h-4 stroke-[1.75]" />
          </button>
        </div>
      </div>

      {/* Terminal */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden p-3 bg-[#f5f5f7]"
        style={{ minHeight: 0 }}
      />

      {/* Footer - единая система Button (sm size) */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50 flex-shrink-0 flex-wrap">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSaveAsSummary}
          disabled={isSaving || (!sessionActive && !fileReady)}
        >
          {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
          {isSaving ? "Сохраняю..." : "Сохранить как резюме"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={handleSendToServer}
          disabled={isSaving || !savedMarkdown || serverStatus === "sent"}
        >
          {serverStatus === "sending" ? (
            <Loader2 className="animate-spin" />
          ) : serverStatus === "sent" ? (
            <CheckCircle2 className="text-green-600" />
          ) : (
            <Cloud />
          )}
          {serverStatus === "sent" ? "Отправлено" : "Отправить на сервер"}
        </Button>

        <Button variant="secondary" size="sm" onClick={handleCopy} disabled={!savedMarkdown}>
          <Copy />
          Скопировать
        </Button>

        <button
          onClick={handleRestart}
          className="ml-auto p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
          title="Перезапустить процесс AI"
          aria-label="Перезапустить"
        >
          <RefreshCw className="w-3.5 h-3.5 stroke-[1.75]" />
        </button>

        {(error || serverStatus === "sent" || serverStatus === "disabled" ||
          (isSavedLocally && serverStatus === "idle")) && (
          <div className="w-full text-xs mt-1">
            {error ? (
              <span className="text-red-600 truncate" title={error}>
                {error}
              </span>
            ) : serverStatus === "sent" ? (
              <span className="text-green-700 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Резюме отправлено на сервер и в окно митинга
              </span>
            ) : serverStatus === "disabled" ? (
              <span className="text-gray-500 flex items-center gap-1">
                <CloudOff className="w-3 h-3" />
                Авто-отправка выключена
              </span>
            ) : isSavedLocally && serverStatus === "idle" ? (
              <span className="text-gray-600">
                Сохранено в окно митинга
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
