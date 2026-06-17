"use client";

import { useEffect, useState } from "react";
import { Cloud, CloudOff } from "lucide-react";

const STORAGE_KEY = "insapp_upload_to_cloud";

/**
 * Чекбокс «Отправить транскрипцию в облако Insapp».
 *
 * Состояние хранится в sessionStorage и читается перед api_save_transcript -
 * если снято, передаём skip_server_upload=true, чтобы backend пропустил отправку.
 *
 * По умолчанию отмечено (ставим true при первом рендере если значение не задано).
 */
export function UploadOptInToggle({ visible }: { visible: boolean }) {
  const [checked, setChecked] = useState<boolean>(true);

  // Загружаем состояние при маунте
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      setChecked(stored === "true");
    } else {
      // По умолчанию включено
      sessionStorage.setItem(STORAGE_KEY, "true");
      setChecked(true);
    }
  }, []);

  const handleToggle = () => {
    const next = !checked;
    setChecked(next);
    sessionStorage.setItem(STORAGE_KEY, next.toString());
    console.log(`[insapp-meet] rec: облако ${next ? "вкл" : "выкл"}`);
  };

  if (!visible) return null;

  return (
    <label
      className="group flex items-center gap-1.5 cursor-pointer select-none"
      title={
        checked
          ? "Транскрипция уйдёт в облако Insapp"
          : "Транскрипция останется только локально (не в облаке Insapp)"
      }
    >
      {checked ? (
        <Cloud className="w-4 h-4 text-primary stroke-[1.75]" />
      ) : (
        <CloudOff className="w-4 h-4 text-muted-foreground stroke-[1.75]" />
      )}
      {/* Только иконка + рубильник (компактно), название - в подсказке */}
      <input
        type="checkbox"
        checked={checked}
        onChange={handleToggle}
        className="sr-only peer"
        aria-label="Отправить транскрипцию в облако Insapp"
      />
      <span
        className={`relative ml-0.5 h-5 w-[34px] shrink-0 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-border"
        }`}
        aria-hidden="true"
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-card shadow transition-transform duration-150 ${
            checked ? "translate-x-[14px]" : "translate-x-0"
          }`}
        />
      </span>
    </label>
  );
}

/** Прочитать текущее состояние (true если отмечен). */
export function getUploadOptIn(): boolean {
  if (typeof window === "undefined") return true;
  const stored = sessionStorage.getItem(STORAGE_KEY);
  return stored === null ? true : stored === "true";
}
