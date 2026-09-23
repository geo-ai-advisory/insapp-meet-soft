"use client";

import { useEffect, useState } from "react";
import { Sparkles, Cloud, CloudOff, CloudUpload, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { useSummaryJobs, useElapsed, humanSummaryError, openClaudeLogin } from "@/hooks/useSummaryJobs";

interface AiTerminalLauncherProps {
  meetingId: string;
  meetingTitle: string;
  /** Больше не нужен: резюме приходит событием ai-summary-saved. Оставлен для совместимости. */
  onSummarySaved?: (markdown: string) => void;
  /** У встречи уже есть резюме - перед пересозданием спросим подтверждение. */
  hasSummary?: boolean;
}

/**
 * Шапка встречи: кнопка AI-резюме + иконка статуса транскрипта.
 *
 * Резюме делается В ФОНЕ (без терминала): бэкенд запускает Claude Sonnet,
 * кнопка показывает «Готовится 1:23», по готовности страница сама подтягивает
 * резюме (событие ai-summary-saved), а всплывашка «Готово» видна на любом экране.
 */
export function AiTerminalLauncher({
  meetingId,
  hasSummary = false,
}: AiTerminalLauncherProps) {
  const jobs = useSummaryJobs();
  const startedMs = jobs[meetingId];
  const running = startedMs !== undefined;
  const elapsed = useElapsed(startedMs);
  const [starting, setStarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [transcriptSync, setTranscriptSync] = useState<string>("unknown");
  const [isResending, setIsResending] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem(`insapp_sync_${meetingId}`);
    if (stored) setTranscriptSync(stored);
  }, [meetingId]);

  const handleResendTranscript = async () => {
    setIsResending(true);
    try {
      const result = await invoke<{ status: string; reason?: string }>(
        "insapp_upload_meeting_by_id",
        { meetingId },
      );
      if (result.status === "sent") {
        setTranscriptSync("sent");
        sessionStorage.setItem(`insapp_sync_${meetingId}`, "sent");
        toast.success("Транскрипция отправлена");
      } else if (result.status === "pending") {
        setTranscriptSync("pending");
        sessionStorage.setItem(`insapp_sync_${meetingId}`, "pending");
        toast.warning("Сервер недоступен");
      } else if (result.status === "failed") {
        setTranscriptSync("failed");
        sessionStorage.setItem(`insapp_sync_${meetingId}`, "failed");
        toast.error("Не удалось отправить", { description: result.reason });
      } else if (result.status === "disabled") {
        toast.info("Отправка отключена в Настройках");
      }
    } catch (e) {
      toast.error("Ошибка отправки", { description: String(e) });
    } finally {
      setIsResending(false);
    }
  };

  /** Запустить резюме в фоне. Ошибка входа в Claude - сразу предлагаем войти. */
  const startSummary = async () => {
    setConfirmOpen(false);
    setStarting(true);
    try {
      await invoke("ai_summary_generate", { meetingId });
      // Дальше всё показывают кнопка («Готовится») и всплывашки - события от бэкенда.
    } catch (e) {
      const err = humanSummaryError(e);
      if (err.auth) {
        toast.error("Резюме не запущено", {
          description: err.text,
          duration: 15000,
          action: { label: "Войти в Claude", onClick: () => openClaudeLogin() },
        });
      } else {
        toast.error("Резюме не запущено", { description: err.text });
      }
    } finally {
      setStarting(false);
    }
  };

  /**
   * Icon-only status pill для транскрипта.
   * Цвет фона + иконка показывают статус, tooltip - детали.
   */
  const renderTranscriptStatusIcon = () => {
    let bg = "";
    let textColor = "";
    let icon: React.ReactNode = null;
    let tooltip = "";
    let clickable = false;

    switch (transcriptSync) {
      case "sent":
        bg = "bg-green-50 hover:bg-green-100 border-green-200";
        textColor = "text-green-700";
        icon = <Cloud className="w-4 h-4" />;
        tooltip = "Транскрипт на сервере";
        break;
      case "pending":
        bg = "bg-amber-50 hover:bg-amber-100 border-amber-200";
        textColor = "text-amber-700";
        icon = <CloudOff className="w-4 h-4" />;
        tooltip = "Транскрипт ждёт отправки (сервер недоступен) - клик чтобы попробовать";
        clickable = true;
        break;
      case "failed":
        bg = "bg-red-50 hover:bg-red-100 border-red-200";
        textColor = "text-red-700";
        icon = <CloudOff className="w-4 h-4" />;
        tooltip = "Ошибка отправки транскрипта - клик чтобы попробовать снова";
        clickable = true;
        break;
      case "disabled":
        bg = "bg-background hover:bg-secondary border-border";
        textColor = "text-muted-foreground";
        icon = <CloudOff className="w-4 h-4" />;
        tooltip = "Транскрипт не отправлялся - клик чтобы отправить";
        clickable = true;
        break;
      case "unknown":
      default:
        bg = "bg-blue-50 hover:bg-blue-100 border-blue-200";
        textColor = "text-blue-700";
        icon = <CloudUpload className="w-4 h-4" />;
        tooltip = "Отправить транскрипт на сервер";
        clickable = true;
        break;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={clickable ? handleResendTranscript : undefined}
            disabled={isResending || !clickable}
            className={`inline-flex items-center justify-center h-8 w-8 rounded-md border ${bg} ${textColor} transition-colors disabled:opacity-50`}
            title={tooltip}
          >
            {isResending ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  };

  const busy = running || starting;
  const label = running
    ? `Готовится ${elapsed}`
    : starting
      ? "Запускаю..."
      : hasSummary
        ? "Сделать заново"
        : "Сделать AI-резюме";

  const mainButton = (
    <Button
      variant="ai"
      size="sm"
      disabled={busy}
      onClick={hasSummary ? undefined : startSummary}
      title={running ? "Claude пишет резюме в фоне - можно закрыть встречу и работать дальше" : undefined}
      className="disabled:opacity-90"
    >
      {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
      {label}
    </Button>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1.5 flex-wrap">
        {hasSummary && !busy ? (
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <PopoverTrigger asChild>{mainButton}</PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-4">
              <p className="text-[13.5px] font-medium text-foreground">Сделать резюме заново?</p>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                Текущее резюме заменится новым. Claude напишет его в фоне за 1-3 минуты.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmOpen(false)}
                  className="rounded-md border border-border px-3 py-1.5 text-[12.5px] text-foreground hover:bg-secondary"
                >
                  Отмена
                </button>
                <button
                  onClick={startSummary}
                  className="rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90"
                >
                  Сделать заново
                </button>
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          mainButton
        )}

        {renderTranscriptStatusIcon()}
      </div>
    </TooltipProvider>
  );
}
