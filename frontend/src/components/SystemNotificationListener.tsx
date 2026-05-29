"use client";

import { useEffect } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

interface MicMeetingAppEvent {
  app_name: string;
  bundle_id: string;
}

/**
 * Слушает событие mic-meeting-app-detected от Rust mic_watcher и показывает
 * НАСТОЯЩЕЕ системное уведомление macOS через tauri-plugin-notification.
 *
 * Почему именно так, а не из Rust backend:
 * - Web Notification API (через JS из webview) триггерит macOS UNUserNotification,
 *   привязанный к bundle id приложения - всплывает в правом верхнем углу как от
 *   Calendar/Mail.
 * - Из Rust backend (через `app.notification().builder().show()`) уведомление
 *   часто silent-fail если вызвано не из webview-контекста.
 * - osascript display notification в macOS 14+ требует grant для Script Editor
 *   которого по умолчанию нет.
 *
 * При первом срабатывании сам попросит permission - macOS покажет диалог
 * «Insapp-meet хочет показывать уведомления». Geo нажимает Разрешить - и дальше
 * каждое уведомление приходит автоматом без prompts.
 */
export function SystemNotificationListener() {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    (async () => {
      // Запрашиваем permission заранее (один раз при первом старте)
      try {
        const granted = await isPermissionGranted();
        if (!granted) {
          await requestPermission();
        }
      } catch (e) {
        console.warn("[SystemNotificationListener] permission request failed:", e);
      }

      // Подписка на событие от mic_watcher
      try {
        unlisten = await listen<MicMeetingAppEvent>(
          "mic-meeting-app-detected",
          async (event) => {
            const { app_name } = event.payload;
            try {
              const granted = await isPermissionGranted();
              if (!granted) {
                // Попробуем ещё раз
                const result = await requestPermission();
                if (result !== "granted") {
                  console.warn("[SystemNotificationListener] permission denied, skipping");
                  return;
                }
              }
              await sendNotification({
                title: "Похоже у тебя встреча",
                body: `${app_name} - открой Insapp-meet и нажми «Начать запись»`,
                sound: "Glass",
              });
              console.log("[SystemNotificationListener] notification sent for", app_name);
            } catch (e) {
              console.error("[SystemNotificationListener] sendNotification failed:", e);
            }
          },
        );
      } catch (e) {
        console.error("[SystemNotificationListener] listen failed:", e);
      }
    })();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return null;
}
