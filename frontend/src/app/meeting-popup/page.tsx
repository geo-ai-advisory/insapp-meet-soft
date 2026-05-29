"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Mic, X } from "lucide-react";

interface PopupData {
  app_name: string;
  bundle_id: string;
}

/**
 * Маленькое всплывающее окно «Записать встречу?».
 *
 * Tauri окно: 360x96px, верхний правый угол, СПЛОШНОЙ БЕЛЫЙ фон.
 * Layout: header (иконка + заголовок + крестик) + строка кнопок,
 * без пустого пространства.
 */
export default function MeetingPopupPage() {
  const [data, setData] = useState<PopupData | null>(null);

  useEffect(() => {
    // Белый сплошной фон html/body. Никаких transparent — раньше попап
    // был полупрозрачным и Telegram было видно через него.
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      html, body { background: #ffffff !important; margin: 0; padding: 0; overflow: hidden; height: 100vh; width: 100vw; }
      #__next, body > div { background: #ffffff !important; }
    `;
    document.head.appendChild(styleEl);

    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await listen<PopupData>("meeting-popup-data", (e) => {
        setData(e.payload);
      });

      // Если данные не пришли в течение 200ms - дёрнем Rust чтобы прислал
      setTimeout(() => {
        invoke<PopupData | null>("meeting_popup_request_data")
          .then((d) => { if (d) setData(d); })
          .catch(() => {});
      }, 200);
    })();

    // Авто-закрытие через 25 секунд
    const timer = setTimeout(() => { closeWindow(); }, 25000);

    return () => {
      if (unlisten) unlisten();
      clearTimeout(timer);
      try { document.head.removeChild(styleEl); } catch (_) {}
    };
  }, []);

  const closeWindow = async () => {
    try {
      await getCurrentWebviewWindow().close();
    } catch (e) {
      console.error("close failed", e);
    }
  };

  const handleRecord = async () => {
    try {
      await invoke("meeting_popup_record", { bundleId: data?.bundle_id ?? "" });
    } catch (e) {
      console.error("record failed", e);
    }
    await closeWindow();
  };

  const handleDismiss = async () => {
    try {
      await invoke("meeting_popup_dismiss", { bundleId: data?.bundle_id ?? "" });
    } catch (e) {
      console.error("dismiss failed", e);
    }
    await closeWindow();
  };

  return (
    <div
      style={{
        width: "360px",
        height: "96px",
        boxSizing: "border-box",
        background: "#ffffff",
      }}
      className="border border-gray-200 rounded-xl shadow-lg px-3 py-2 flex flex-col justify-between gap-1.5"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-red-50 flex items-center justify-center">
          <Mic className="w-3.5 h-3.5 text-red-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 leading-tight truncate">
            Похоже у тебя встреча
          </p>
          <p className="text-xs text-gray-600 leading-tight truncate">
            {data?.app_name ?? "Видеосвязь"} — записать?
          </p>
        </div>
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 p-0.5 hover:bg-gray-100 rounded transition-colors"
          aria-label="Закрыть"
        >
          <X className="w-4 h-4 text-gray-400" />
        </button>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={handleRecord}
          className="flex-1 h-7 px-2 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded-md transition-colors"
        >
          Да, записать
        </button>
        <button
          onClick={handleDismiss}
          className="h-7 px-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium rounded-md transition-colors"
        >
          Игнорировать
        </button>
      </div>
    </div>
  );
}
