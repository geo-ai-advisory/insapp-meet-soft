"use client";

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RecState {
  is_recording: boolean;
  is_paused: boolean;
  active_duration: number | null;
}

/**
 * Плавающий индикатор записи («пилюля»). Standalone-окно поверх всех приложений.
 *
 * ИСПРАВЛЕНИЕ БАГА:
 *  - Окно создаётся/закрывается из Rust по реальному состоянию записи (см. recording_indicator.rs),
 *    а не по фронтовым событиям.
 *  - Таймер и состояние ПАУЗЫ читаются из get_recording_state (active_duration исключает паузу) -
 *    пилюля не врёт и не отстаёт.
 *  - ПАУЗА и СТОП шлют событие в главное окно (recording_indicator_toggle_pause / recording_indicator_stop),
 *    где отрабатывает ТОТ ЖЕ путь, что и у основного UI - единый источник истины.
 */
export default function RecordingIndicatorPage() {
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const stoppingRef = useRef(false);

  useEffect(() => {
    // Непрозрачный тёмный фон окна (прозрачные окна в этом приложении рендерятся пустыми).
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      html, body { background: transparent !important; margin: 0; padding: 0; overflow: hidden; height: 100vh; width: 100vw; }
      #__next, body > div { background: transparent !important; height: 100vh; }
      @keyframes pill-ring { 0%,100% { transform: scale(1); opacity: 0.55; } 50% { transform: scale(1.18); opacity: 0; } }
      @keyframes pill-bar  { 0%,100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
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

  const mmss = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

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

  const accent = paused ? "#F59E0B" : "#EF4444"; // янтарь на паузе, красный в записи

  return (
    <div
      data-tauri-drag-region
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", padding: "6px", background: "transparent", cursor: "grab" }}
    >
      <div
        data-tauri-drag-region
        style={{
          width: "54px", height: "100%",
          background: "linear-gradient(180deg, #2A2A2E 0%, #1A1A1C 100%)",
          border: "1px solid rgba(255,255,255,0.10)", borderRadius: "27px",
          boxShadow: "0 10px 32px rgba(0,0,0,0.40), 0 2px 8px rgba(0,0,0,0.30)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between",
          padding: "12px 0", WebkitUserSelect: "none", userSelect: "none",
        }}
      >
        {/* Микрофон в круге + пульсирующее кольцо (нет пульса на паузе) */}
        <div style={{ position: "relative", width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {!paused && (
            <span style={{ position: "absolute", width: "28px", height: "28px", borderRadius: "50%", border: `2px solid ${accent}`, animation: "pill-ring 1.6s ease-out infinite" }} />
          )}
          <span style={{ width: "20px", height: "20px", borderRadius: "50%", background: accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="11" rx="3" fill="#fff" stroke="none" />
              <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </span>
        </div>

        {/* Уровень: 4 столбика (замирают на паузе) */}
        <div style={{ display: "flex", alignItems: "center", gap: "3px", height: "26px" }}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} style={{
              width: "3.5px", height: "20px", borderRadius: "2px", background: accent, transformOrigin: "center",
              animation: paused ? "none" : `pill-bar 0.9s ease-in-out ${i * 0.13}s infinite`,
              transform: paused ? "scaleY(0.4)" : undefined, opacity: paused ? 0.5 : 1,
            }} />
          ))}
        </div>

        {/* Таймер (активное время, без паузы) */}
        <div style={{ fontFamily: "Inter, -apple-system, system-ui, sans-serif", fontVariantNumeric: "tabular-nums", fontSize: "11px", fontWeight: 600, color: "#F5F5F7", letterSpacing: "0.01em" }}>
          {mmss(elapsed)}
        </div>

        {/* Пауза / возобновление */}
        <button
          onClick={handlePause}
          aria-label={paused ? "Возобновить запись" : "Пауза записи"}
          title={paused ? "Возобновить" : "Пауза"}
          style={{ width: "32px", height: "32px", borderRadius: "9px", border: "none", cursor: "pointer", background: "rgba(255,255,255,0.10)", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 120ms" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.18)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.10)"; }}
        >
          {paused ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" stroke="none"><path d="M7 4l13 8-13 8z" /></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
          )}
        </button>

        {/* СТОП */}
        <button
          onClick={handleStop}
          aria-label="Остановить запись"
          title="Остановить запись"
          style={{ width: "34px", height: "34px", borderRadius: "11px", border: "none", cursor: "pointer", background: accent, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(239,68,68,0.45)", transition: "transform 120ms ease-out, filter 120ms ease-out" }}
          onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.1)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
          onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.92)"; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
        >
          <span style={{ width: "12px", height: "12px", borderRadius: "3px", background: "#fff" }} />
        </button>
      </div>
    </div>
  );
}
