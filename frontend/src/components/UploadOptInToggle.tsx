"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, CloudOff, Laptop } from "lucide-react";

const STORAGE_KEY = "insapp_upload_to_cloud";
const EVENT = "upload-optin-changed";

/**
 * Выбор «отправить эту встречу на сервер» - один на всё окно: облачко в плашке записи, переключатель
 * в шапке записи и в окне «Сохранить встречу» показывают и меняют одно и то же (Geo 06.10: «при идущей
 * записи кнопку контроля авто отправки встречи на сервер, чтобы сохранить встречу только локально»).
 */
export function setUploadOptIn(next: boolean) {
  if (typeof window === "undefined") return;
  try { sessionStorage.setItem(STORAGE_KEY, String(next)); } catch { /* нет хранилища - выбор живёт до перезапуска окна */ }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: next }));
  console.log(`[insapp-meet] rec: на сервер ${next ? "вкл" : "выкл"}`);
}

/** Новая запись - снова «на сервер»: «только на компьютере» выбирают для одной встречи. */
export function resetUploadOptIn() {
  setUploadOptIn(true);
}

export function useUploadOptIn(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(getUploadOptIn());
    const f = (e: Event) => setOn(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  return [on, setUploadOptIn];
}

/** Отправка на сервер включена в настройках (null - ещё не знаем). Выключена - отдельной встречи это тоже касается. */
export function useServerAutoUpload(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<{ settings?: { auto_upload?: boolean } }>("insapp_get_status")
      .then((s) => { if (alive) setOn(s?.settings?.auto_upload !== false); })
      .catch(() => { if (alive) setOn(null); });
    return () => { alive = false; };
  }, []);
  return on;
}

/**
 * Шапка экрана записи: рубильник «куда уйдёт встреча» значками - слева компьютер, справа облако,
 * бегунок стоит на выбранном (Geo 06.10: «нужен рубильник, иначе не понятно, какой статус - на сервер
 * уходит или локально, и просто значками»). Облако - встреча уйдёт на сервер, компьютер - останется здесь.
 */
export function UploadChip() {
  const [on, set] = useUploadOptIn();
  const global = useServerAutoUpload();
  const off = global === false;
  const sending = on && !off;
  const title = off
    ? "Отправка на сервер выключена в настройках - встреча останется на этом компьютере"
    : sending
      ? "Встреча уйдёт на сервер Insapp. Переключите, чтобы оставить её только на этом компьютере"
      : "Встреча останется только на этом компьютере. Переключите, чтобы отправить на сервер";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={sending}
      aria-label={sending ? "Встреча уйдёт на сервер" : "Встреча останется только на этом компьютере"}
      title={title}
      disabled={off}
      onClick={() => set(!on)}
      className={`relative h-[30px] w-[62px] flex-none rounded-[15px] transition-colors duration-200 disabled:cursor-default disabled:opacity-60 ${
        sending ? "bg-im-tone hover:bg-im-tone-h" : "bg-im-bg hover:bg-im-tray-h"
      }`}
    >
      <Laptop className="absolute left-[9px] top-[8px] h-3.5 w-3.5 text-im-mut2" strokeWidth={2.2} aria-hidden="true" />
      <Cloud className="absolute right-[9px] top-[8px] h-3.5 w-3.5 text-im-mut2" strokeWidth={2.2} aria-hidden="true" />
      <span
        aria-hidden="true"
        className={`absolute left-[3px] top-[3px] grid h-6 w-[26px] place-items-center rounded-full bg-white shadow-[0_1px_3px_rgba(16,24,40,.18)] transition-transform duration-200 ${
          sending ? "translate-x-[30px]" : "translate-x-0"
        }`}
      >
        {sending ? <Cloud className="h-3.5 w-3.5 text-im-acc" strokeWidth={2.4} /> : <Laptop className="h-3.5 w-3.5 text-im-ink2" strokeWidth={2.4} />}
      </span>
    </button>
  );
}

/**
 * Чекбокс «Отправить транскрипцию в облако Insapp».
 *
 * Состояние хранится в sessionStorage и читается перед api_save_transcript -
 * если снято, передаём skip_server_upload=true, чтобы backend пропустил отправку.
 *
 * По умолчанию отмечено (ставим true при первом рендере если значение не задано).
 */
export function UploadOptInToggle({ visible, variant = 'switch' }: { visible: boolean; variant?: 'switch' | 'icon' }) {
  const [checked, set] = useUploadOptIn();
  const handleToggle = () => set(!checked);

  if (!visible) return null;

  // Плашка записи главного экрана: только облачко, нажатие переключает отправку в облако.
  if (variant === 'icon') {
    const title = checked
      ? "Отправка на сервер включена - нажмите, чтобы оставить эту встречу только на компьютере"
      : "Эта встреча останется только на компьютере - нажмите, чтобы отправить на сервер";
    return (
      <button
        type="button"
        onClick={handleToggle}
        aria-pressed={checked}
        aria-label={checked ? "Отправка на сервер включена" : "Отправка на сервер выключена"}
        title={title}
        className="grid h-6 w-6 flex-none place-items-center rounded-full text-im-mut transition-colors hover:text-im-ink2"
      >
        {checked ? <Cloud className="h-[17px] w-[17px]" /> : <CloudOff className="h-[17px] w-[17px]" />}
      </button>
    );
  }

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
