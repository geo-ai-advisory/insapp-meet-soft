"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Video, X } from "lucide-react";

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
    // ПРОЗРАЧНЫЙ фон окна (html/body), чтобы углы за border-radius карточки не
    // заливались квадратной подложкой. Сплошной светлый фон несёт сама карточка
    // ниже (div с background --card + тень). Окно создано с transparent=true.
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      html, body { background: transparent !important; margin: 0; padding: 0; overflow: hidden; height: 100vh; width: 100vw; }
      #__next, body > div { background: transparent !important; }
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
    console.log('[insapp-meet] popup: запись подтверждена (' + (data?.app_name ?? "неизвестно") + ')');
    try {
      await invoke("meeting_popup_record", { bundleId: data?.bundle_id ?? "" });
    } catch (e) {
      console.error("record failed", e);
    }
    await closeWindow();
  };

  const handleDismiss = async () => {
    console.log('[insapp-meet] popup: предложение отклонено (' + (data?.app_name ?? "неизвестно") + ')');
    try {
      await invoke("meeting_popup_dismiss", { bundleId: data?.bundle_id ?? "", name: data?.app_name ?? "" });
    } catch (e) {
      console.error("dismiss failed", e);
    }
    await closeWindow();
  };

  return (
    // Прозрачная подложка во весь размер окна; карточка по центру, вокруг неё
    // прозрачный гаттер (12px) для мягкой тени — углы окна не дают квадратной рамки.
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        boxSizing: "border-box",
      }}
    >
    <div
      style={{
        width: "360px",
        height: "96px",
        boxSizing: "border-box",
        background: "hsl(var(--card))",
      }}
      className="border border-border rounded-xl shadow-lg px-3 py-2 flex flex-col justify-between gap-1.5"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-[hsl(var(--brand-blue))]/10 flex items-center justify-center">
          <Video className="w-[18px] h-[18px] text-[hsl(var(--brand-blue))]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-tight truncate">
            Похоже, у вас встреча{data?.app_name ? ` в ${data.app_name}` : ''}
          </p>
          <p className="text-xs text-muted-foreground leading-tight truncate">
            Записать её автоматически?
          </p>
        </div>
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 p-0.5 hover:bg-secondary rounded transition-colors"
          aria-label="Закрыть"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={handleRecord}
          className="flex-1 inline-flex items-center justify-center gap-1.5 h-7 px-2 bg-primary hover:brightness-105 text-primary-foreground text-xs font-medium rounded-md transition-[filter] active:scale-[0.98]"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          Записать
        </button>
        <button
          onClick={handleDismiss}
          className="h-7 px-2 bg-secondary hover:bg-accent text-secondary-foreground text-xs font-medium rounded-md transition-colors active:scale-[0.98]"
        >
          Игнорировать
        </button>
      </div>
    </div>
    </div>
  );
}
