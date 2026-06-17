"use client";

import React, { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";
import { Mic, X } from "lucide-react";
import { useRecordingState } from "@/contexts/RecordingStateContext";
import { Button } from "./ui/button";

interface MicMeetingAppEvent {
  app_name: string;
  bundle_id: string;
}

/**
 * Тост-попап: «Похоже, у тебя встреча в Telemost. Записать?»
 *
 * Появляется в правом верхнем углу когда Insapp-meet обнаруживает что
 * пользователь в приложении для видеосвязи (Telemost/Zoom/Meet/Teams/...).
 *
 * Логика:
 * - Слушает Tauri event "mic-meeting-app-detected"
 * - Если уже идёт запись - не показывает
 * - «Да, записать» → переходит на главную и стартует запись
 * - «Игнорировать» → закрывает + cooldown 5 мин на это приложение (через rust)
 * - Авто-закрытие через 15 секунд
 */
export function MeetingAppToast() {
  const router = useRouter();
  const { isRecording } = useRecordingState();
  const [event, setEvent] = useState<MicMeetingAppEvent | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        unlisten = await listen<MicMeetingAppEvent>(
          "mic-meeting-app-detected",
          (e) => {
            // Если уже идёт запись - просто игнорируем (не показываем попап)
            if (isRecording) return;
            setEvent(e.payload);
          },
        );
      } catch (err) {
        console.error("MeetingAppToast: не удалось подписаться", err);
      }
    })();

    return () => {
      if (unlisten) unlisten();
    };
  }, [isRecording]);

  // Авто-закрытие через 15 секунд - просто скрываем popup без ignore
  useEffect(() => {
    if (!event) return;
    const timer = setTimeout(() => {
      setEvent(null);
    }, 15000);
    return () => clearTimeout(timer);
  }, [event]);

  if (!event) return null;

  const handleRecord = async () => {
    // Помечаем чтобы повторно не показывать, и сразу идём на главную - там стартует запись
    try {
      await invoke("mic_watcher_mark_ignored", { bundleId: event.bundle_id });
    } catch (_) {}

    // Используем тот же механизм что Sidebar - sessionStorage + переход на /
    sessionStorage.setItem("autoStartRecording", "true");
    setEvent(null);
    router.push("/");
  };

  // Просто закрыть popup без добавления приложения в ignore.
  // Если пользователь нажал крестик - значит "не сейчас", но через 5 мин
  // (cooldown ниже после mic-trigger) попап может появиться снова.
  const handleClose = () => {
    setEvent(null);
  };

  // Полностью игнорировать приложение - больше не показывать попап для него.
  // Backend mic_watcher_mark_ignored ставит cooldown 5 мин на этот bundle_id;
  // для нашего UX этого достаточно ("не предлагать для этого приложения сейчас").
  const handleIgnoreApp = async () => {
    try {
      await invoke("mic_watcher_mark_ignored", { bundleId: event.bundle_id });
    } catch (_) {}
    setEvent(null);
  };

  return (
    <div className="fixed top-6 right-6 z-50 w-80 animate-in slide-in-from-top-2 fade-in duration-200">
      <div className="bg-card border border-border rounded-xl shadow-2xl p-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
            <Mic className="w-5 h-5 text-red-500 stroke-[1.75]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground leading-tight">
              Кажется, у тебя встреча в&nbsp;{event.app_name}
            </p>
            <p className="text-sm text-muted-foreground mt-1">Записать?</p>
            <div className="flex flex-col gap-2 mt-3">
              <Button variant="destructive" onClick={handleRecord} className="w-full">
                <Mic />
                Да, записать
              </Button>
              <Button
                variant="secondary"
                onClick={handleIgnoreApp}
                className="w-full"
                title={`Не предлагать запись для ${event.app_name}`}
              >
                Игнорировать {event.app_name}
              </Button>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="flex-shrink-0 p-1 hover:bg-secondary rounded-md transition-colors"
            aria-label="Закрыть"
            title="Закрыть"
          >
            <X className="w-4 h-4 text-muted-foreground stroke-[1.75]" />
          </button>
        </div>
      </div>
    </div>
  );
}
