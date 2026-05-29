"use client";

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bell, BellOff, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";

type Status = "loading" | "granted" | "denied" | "default";

/**
 * Карточка «Системные уведомления» с явной кнопкой включения.
 *
 * macOS регистрирует приложение в Notification Center только если
 * `requestPermission()` вызвано когда приложение в foreground.
 * Поэтому отдельная кнопка - юзер кликает, приложение точно в foreground,
 * macOS показывает grant-диалог.
 */
export function NotificationPermissionCard() {
  const [status, setStatus] = useState<Status>("default");
  const [isRequesting, setIsRequesting] = useState(false);

  // Уведомления идут через sidecar terminal-notifier. macOS показывает grant-диалог
  // для terminal-notifier при первом запуске. После разрешения работают всегда.
  const handleEnable = async () => {
    setIsRequesting(true);
    try {
      await invoke<string>("system_notify_test");
      // Если invoke прошёл - запрос ушёл. macOS либо показал диалог, либо разрешение уже есть.
      setStatus("granted");
      toast.success("Тестовое уведомление отправлено", {
        description:
          "Если ты видишь его в правом верхнем углу - всё работает. Если macOS попросит разрешение - нажми «Разрешить».",
      });
    } catch (e) {
      toast.error("Ошибка отправки уведомления", { description: String(e) });
    } finally {
      setIsRequesting(false);
    }
  };

  const handleTest = handleEnable;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <div className="flex items-start gap-3">
        {status === "granted" ? (
          <Bell className="w-5 h-5 text-green-600 mt-0.5" />
        ) : (
          <BellOff className="w-5 h-5 text-gray-400 mt-0.5" />
        )}
        <div className="flex-1">
          <h3 className="text-base font-semibold text-gray-900 mb-1">
            Системные уведомления
          </h3>
          <p className="text-sm text-gray-600 mb-3">
            Когда ты заходишь в Telemost / Zoom / Teams / FaceTime / Discord -
            macOS показывает уведомление в правом верхнем углу с предложением записать встречу.
          </p>

          {status === "granted" && (
            <div className="flex items-center gap-3 mb-3">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-green-700 bg-green-50 rounded-full border border-green-200">
                <CheckCircle2 className="w-3 h-3" />
                Тестовое отправлено
              </span>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleEnable} disabled={isRequesting} size="sm">
              {isRequesting && <Loader2 className="w-3 h-3 mr-2 animate-spin" />}
              {status === "granted" ? "Отправить ещё раз" : "Тест уведомления"}
            </Button>
            <p className="text-xs text-gray-500">
              Если macOS попросит разрешение - нажми «Разрешить» в системном диалоге.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
