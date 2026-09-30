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
 * Карточка 360x96 в прозрачном окне (верхний правый угол), вид - как карточки главного экрана:
 * значок встречи в голубом круге, заголовок и подпись, красная «Записать» и белая «Игнорировать»
 * (навсегда отключает подсказку для этого приложения - см. meeting_popup_dismiss).
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
    // прозрачный гаттер (12px) для мягкой тени - углы окна не дают квадратной рамки.
    // Вид - как карточки главного экрана (Geo 30.09: всплывающие окна в стиле приложения): белая карточка
    // со скруглением, тон #E6EEFF у значка, красная только кнопка записи.
    <div className="flex h-screen w-screen items-center justify-center bg-transparent font-sans">
      <div className="flex h-24 w-[360px] flex-col justify-between rounded-[22px] bg-white px-3.5 py-2.5 shadow-[0_8px_24px_rgba(16,24,40,.13),0_2px_6px_rgba(16,24,40,.08),inset_0_0_0_1px_rgba(16,24,40,.06)]">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-im-tone text-im-on-tone" aria-hidden="true">
            <Video className="h-[17px] w-[17px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-bold leading-[18px] text-im-ink">
              Похоже, у вас встреча{data?.app_name ? ` в ${data.app_name}` : ""}
            </p>
            <p className="truncate text-[12.5px] leading-4 text-im-mut">Записать её автоматически?</p>
          </div>
          <button
            onClick={handleDismiss}
            className="grid h-7 w-7 flex-none place-items-center rounded-full text-im-mut transition-colors hover:bg-im-tray hover:text-im-ink2"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleRecord}
            className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-2xl bg-im-rec text-[13px] font-semibold text-white shadow-[0_2px_6px_rgba(205,35,20,.28)] transition-[background,border-radius] duration-200 hover:bg-im-rec-h active:rounded-xl"
          >
            <span className="h-2 w-2 rounded-full bg-white" />
            Записать
          </button>
          <button
            onClick={handleDismiss}
            className="h-8 rounded-2xl bg-white px-3.5 text-[13px] font-semibold text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line2)] transition-[background,border-radius] duration-200 hover:bg-im-hover active:rounded-xl"
          >
            Игнорировать
          </button>
        </div>
      </div>
    </div>
  );
}
