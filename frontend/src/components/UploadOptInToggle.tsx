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
  };

  if (!visible) return null;

  return (
    <label
      className="flex items-center gap-2 cursor-pointer select-none px-3 py-1.5 bg-white rounded-full shadow text-xs"
      title={
        checked
          ? "После остановки записи транскрипция уйдёт на сервер Insapp"
          : "Транскрипция не будет отправлена на сервер - останется только локально"
      }
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={handleToggle}
        className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      />
      {checked ? (
        <Cloud className="w-3.5 h-3.5 text-blue-600" />
      ) : (
        <CloudOff className="w-3.5 h-3.5 text-gray-400" />
      )}
      <span className={checked ? "text-gray-900" : "text-gray-500"}>
        Отправить в облако Insapp
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
