"use client";

import { useEffect, useState } from "react";
import { Sparkles, Cloud, CloudOff, CloudUpload, Loader2, ChevronUp, CheckCircle2, AlertCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { TerminalPanel } from "./TerminalPanel";

interface AiTerminalLauncherProps {
  meetingId: string;
  meetingTitle: string;
  onSummarySaved?: (markdown: string) => void;
}

/**
 * Inline header: gradient AI button + icon-only status кнопки.
 * Все элементы h-8, в одну строку, с tooltips.
 */
export function AiTerminalLauncher({
  meetingId,
  meetingTitle,
  onSummarySaved,
}: AiTerminalLauncherProps) {
  const [terminalState, setTerminalState] = useState<
    "closed" | "open" | "minimized"
  >("closed");
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
        bg = "bg-gray-50 hover:bg-gray-100 border-gray-200";
        textColor = "text-gray-600";
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

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          variant="ai"
          size="sm"
          onClick={() => setTerminalState("open")}
        >
          <Sparkles />
          {terminalState === "minimized" ? "Открыть AI-резюме" : "Сделать AI-резюме"}
        </Button>

        {renderTranscriptStatusIcon()}
      </div>

      {/* Terminal panel */}
      {terminalState !== "closed" && (
        <div
          className="fixed inset-y-0 right-0 z-40 w-full max-w-2xl border-l border-gray-200 shadow-2xl bg-white flex flex-col"
          style={{ display: terminalState === "minimized" ? "none" : "flex" }}
        >
          <TerminalPanel
            meetingId={meetingId}
            meetingTitle={meetingTitle}
            wasUploadedToServer={transcriptSync === "sent"}
            onMinimize={() => setTerminalState("minimized")}
            onClose={() => setTerminalState("closed")}
            onSummarySaved={(md) => {
              if (onSummarySaved) onSummarySaved(md);
            }}
          />
        </div>
      )}

      {/* Floating reopen */}
      {terminalState === "minimized" && (
        <button
          onClick={() => setTerminalState("open")}
          className="fixed bottom-6 right-6 z-30 flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-full shadow-lg hover:shadow-xl transition-shadow"
          title="Развернуть AI-резюме"
        >
          <Sparkles className="w-4 h-4 text-blue-600 stroke-[1.75]" />
          <span className="text-sm font-medium text-gray-900">AI-резюме работает</span>
          <ChevronUp className="w-3.5 h-3.5 text-gray-500 stroke-[1.75]" />
        </button>
      )}
    </TooltipProvider>
  );
}
