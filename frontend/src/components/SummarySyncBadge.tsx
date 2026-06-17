"use client";

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Cloud,
  CloudOff,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface SummarySyncBadgeProps {
  meetingId: string;
  syncStatus?: "sent" | "pending" | "failed" | "disabled" | string;
  syncedAt?: string;
  onResent?: () => void;
}

/**
 * Icon-only badge статуса синхронизации резюме на сервере.
 * Цвет показывает состояние, tooltip - детали.
 * Если статус не sent - кликабельный для переотправки.
 */
export function SummarySyncBadge({
  meetingId,
  syncStatus,
  syncedAt,
  onResent,
}: SummarySyncBadgeProps) {
  const [isSending, setIsSending] = useState(false);
  const [localStatus, setLocalStatus] = useState<string | undefined>(syncStatus);

  const status = localStatus ?? syncStatus ?? "unknown";

  const handleResend = async () => {
    setIsSending(true);
    try {
      const res = await invoke<{ sync_status: string }>(
        "ai_summary_resend_to_server",
        { meetingId },
      );
      setLocalStatus(res.sync_status);
      if (res.sync_status === "sent") {
        toast.success("Резюме отправлено");
      } else if (res.sync_status === "pending") {
        toast.warning("Сервер недоступен");
      } else if (res.sync_status === "failed") {
        toast.error("Не удалось отправить");
      } else if (res.sync_status === "disabled") {
        toast.info("Авто-отправка выключена в Настройках");
      }
      if (onResent) onResent();
    } catch (e) {
      toast.error("Ошибка", { description: String(e) });
    } finally {
      setIsSending(false);
    }
  };

  if (status === "unknown") return null;

  let bg = "";
  let textColor = "";
  let icon: React.ReactNode = null;
  let tooltip = "";
  let clickable = false;

  switch (status) {
    case "sent":
      bg = "bg-green-50 hover:bg-green-100 border-green-200";
      textColor = "text-green-700";
      icon = <CheckCircle2 className="w-4 h-4" />;
      tooltip = syncedAt
        ? `Резюме на сервере (${new Date(syncedAt).toLocaleString("ru-RU")})`
        : "Резюме на сервере";
      break;
    case "pending":
      bg = "bg-amber-50 hover:bg-amber-100 border-amber-200";
      textColor = "text-amber-700";
      icon = <CloudOff className="w-4 h-4" />;
      tooltip = "Резюме ждёт отправки - клик чтобы попробовать";
      clickable = true;
      break;
    case "failed":
      bg = "bg-red-50 hover:bg-red-100 border-red-200";
      textColor = "text-red-700";
      icon = <AlertCircle className="w-4 h-4" />;
      tooltip = "Ошибка отправки резюме - клик чтобы попробовать снова";
      clickable = true;
      break;
    case "disabled":
      bg = "bg-background hover:bg-secondary border-border";
      textColor = "text-muted-foreground";
      icon = <CloudOff className="w-4 h-4" />;
      tooltip = "Авто-отправка выключена - клик чтобы отправить разово";
      clickable = true;
      break;
    default:
      return null;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={clickable ? handleResend : undefined}
            disabled={isSending || !clickable}
            className={`inline-flex items-center justify-center h-8 w-8 rounded-md border ${bg} ${textColor} transition-colors disabled:opacity-50`}
            title={tooltip}
          >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
