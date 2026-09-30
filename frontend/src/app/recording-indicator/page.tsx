"use client";

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pause, Play } from "lucide-react";
import { formatClock } from "@/lib/meetingFormat";

interface RecState {
  is_recording: boolean;
  is_paused: boolean;
  active_duration: number | null;
}

/**
 * Плавающий индикатор записи («пилюля»). Standalone-окно поверх всех приложений.
 *
 * Вид - как плашка записи на главном экране (дизайн «Экспрессив» в палитре «Воздушный», Geo 30.09:
 * «пилюлю тоже обновить, чтобы визуально соответствовала приложению»): белая капсула с мягкой тенью,
 * красные только точка записи, таймер и круглая «Стоп»; уровень звука - голубые полоски как у микрофона;
 * «Пауза» - белая круглая кнопка с рамкой. На паузе точка и полоски замирают, таймер серый.
 *
 * Логика прежняя:
 *  - Окно создаётся/закрывается из Rust по реальному состоянию записи (см. recording_indicator.rs).
 *  - Таймер и пауза читаются из get_recording_state (active_duration без пауз).
 *  - ПАУЗА и СТОП шлют событие в главное окно (recording_indicator_toggle_pause / recording_indicator_stop),
 *    где отрабатывает ТОТ ЖЕ путь, что и у основного UI.
 */
export default function RecordingIndicatorPage() {
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const stoppingRef = useRef(false);

  useEffect(() => {
    // Фон окна прозрачный: видна только капсула с тенью (окно больше капсулы - запас под тень).
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      html, body { background: transparent !important; margin: 0; padding: 0; overflow: hidden; height: 100vh; width: 100vw; }
      #__next, body > div { background: transparent !important; height: 100vh; }
    `;
    document.head.appendChild(styleEl);

    let alive = true;
    const poll = async () => {
      try {
        const s = await invoke<RecState>("get_recording_state");
        if (!alive) return;
        setElapsed(Math.floor(s?.active_duration ?? 0));
        setPaused(!!s?.is_paused);
      } catch (_) { /* окно живёт только во время записи */ }
    };
    poll();
    const id = setInterval(poll, 500);
    return () => { alive = false; clearInterval(id); try { document.head.removeChild(styleEl); } catch (_) {} };
  }, []);

  const handleStop = async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    console.log("[insapp-meet] pill: СТОП");
    try {
      await invoke("recording_indicator_stop");
    } catch (e) {
      console.error("[insapp-meet] pill: ошибка стопа", e);
      stoppingRef.current = false;
    }
  };

  const handlePause = async () => {
    console.log("[insapp-meet] pill: пауза/возобновление");
    try { await invoke("recording_indicator_toggle_pause"); } catch (e) { console.error("[insapp-meet] pill: ошибка паузы", e); }
  };

  const clock = formatClock(elapsed);
  const long = clock.length > 5; // больше часа: «1:02:03»

  return (
    <div data-tauri-drag-region className="flex h-screen w-screen select-none items-center justify-center bg-transparent font-sans">
      <div
        data-tauri-drag-region
        role="group"
        aria-label={paused ? "Запись на паузе" : "Идёт запись"}
        className={`flex w-14 cursor-grab flex-col items-center rounded-[28px] bg-white pb-[9px] pt-3.5 shadow-[0_8px_24px_rgba(16,24,40,.13),0_2px_6px_rgba(16,24,40,.08),inset_0_0_0_1px_rgba(16,24,40,.06)] ${paused ? "im-paused" : ""}`}
      >
        {/* Точка записи и таймер - красные, как на плашке записи */}
        <i data-tauri-drag-region className="im-rdot block h-2 w-2 flex-none rounded-full bg-im-rec" aria-hidden="true" />
        <time
          data-tauri-drag-region
          className={`mt-2 font-semibold leading-[18px] im-num ${long ? "text-[11px]" : "text-[13.5px]"} ${paused ? "text-im-mut" : "text-im-rec-text"}`}
          aria-label="Длительность записи"
        >
          {clock}
        </time>
        <span data-tauri-drag-region className={`h-4 text-[10.5px] font-semibold leading-4 text-im-mut ${paused ? "" : "invisible"}`}>
          пауза
        </span>

        {/* Уровень звука: голубые полоски, на паузе замирают */}
        <span data-tauri-drag-region className={`im-lvl mt-1 inline-flex h-4 items-center gap-[3px] [&>i:nth-child(4)]:[animation-delay:-.2s] [&>i]:w-[3px] [&>i]:rounded-full ${paused ? "text-im-dotm" : "text-im-data"}`} aria-hidden="true">
          <i /><i /><i /><i />
        </span>

        {/* Пауза / продолжить - белая круглая с рамкой */}
        <button
          type="button"
          onClick={handlePause}
          aria-label={paused ? "Продолжить запись" : "Пауза записи"}
          title={paused ? "Продолжить" : "Пауза"}
          className="mt-3.5 grid h-9 w-9 place-items-center rounded-full bg-white text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line2)] transition-[background,border-radius] duration-200 hover:bg-im-hover active:rounded-xl"
        >
          {paused ? <Play className="h-4 w-4 translate-x-px" fill="currentColor" strokeWidth={0} /> : <Pause className="h-4 w-4" fill="currentColor" strokeWidth={0} />}
        </button>

        {/* Стоп - круглая красная, как в плашке записи */}
        <button
          type="button"
          onClick={handleStop}
          aria-label="Остановить запись"
          title="Остановить запись"
          className="mt-2 grid h-[38px] w-[38px] place-items-center rounded-full bg-im-rec text-white shadow-[0_3px_8px_rgba(205,35,20,.35),inset_0_1px_0_rgba(255,255,255,.25)] transition-[transform,background] duration-200 hover:scale-[1.04] hover:bg-im-rec-h active:scale-95"
        >
          <span className="block h-3.5 w-3.5 rounded-[3px] bg-white" />
        </button>
      </div>
    </div>
  );
}
