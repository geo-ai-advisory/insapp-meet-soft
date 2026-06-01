"use client";

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sparkles, Loader2, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import Image from "next/image";

interface IdentityGateProps {
  /** Вызывается когда пользователь зарегистрировался или пропустил шаг. */
  onDone: () => void;
}

/**
 * Экран первого входа: пользователь представляется (ФИО), приложение
 * автоматически регистрирует его на корпоративном сервере и получает
 * персональный API ключ.
 *
 * Показывается ОДИН раз - после регистрации credentials сохраняются и
 * gate больше не появляется. Можно пропустить (зарегистрироваться позже
 * в Настройки → Сервер Insapp).
 */
export function IdentityGate({ onDone }: IdentityGateProps) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string>("");

  useEffect(() => {
    invoke<{ settings: { server_url: string } }>("insapp_get_status")
      .then((s) => setServerUrl(s.settings.server_url))
      .catch(() => {});
  }, []);

  const handleRegister = async () => {
    if (login.trim().length < 2 || password.length < 1) {
      setError("Введи логин и пароль");
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await invoke<{ registered: boolean; login: string }>(
        "insapp_register_with_server",
        { login: login.trim(), password },
      );
      onDone();
      // В фоне (не блокируем вход): сначала заливаем локальные встречи на сервер,
      // потом подтягиваем облачные, которых нет локально (с других устройств).
      invoke<{ total: number; sent: number; queued: number }>(
        "insapp_upload_all_meetings",
      )
        .then((r) => {
          if (r && r.total > 0) {
            toast.success(
              `Перенёс встречи на сервер: отправлено ${r.sent}` +
                (r.queued > 0 ? `, в очереди ${r.queued}` : ""),
            );
          }
          return invoke<{ synced: number; total: number }>("insapp_sync_from_server");
        })
        .then((s) => {
          if (s && s.synced > 0) {
            toast.success(`Подтянул встречи из облака: ${s.synced}`);
            setTimeout(() => window.location.reload(), 1200);
          }
        })
        .catch(() => {
          /* синхронизацию можно повторить из профиля */
        });
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as any)?.message || String(e);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isLoading) {
      handleRegister();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <div className="w-full max-w-md mx-auto px-8">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <Image
            src="/icon_128x128.png"
            alt="Insapp-meet"
            width={64}
            height={64}
            className="mb-4"
          />
          <h1 className="text-2xl font-semibold text-gray-900">Insapp-meet</h1>
          <p className="text-sm text-gray-500 mt-1">
            Запись и AI-резюме встреч
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-6">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-blue-600 stroke-[1.75]" />
            <h2 className="text-base font-semibold text-gray-900">
              Вход
            </h2>
          </div>
          <p className="text-sm text-gray-600 mb-5">
            Войди под своей учётной записью - тем же логином и паролем, что для
            дашборда. Встречи будут подписаны твоей учёткой. Это нужно один раз.
          </p>

          <label className="block text-xs font-medium text-gray-500 mb-1.5">
            Логин
          </label>
          <input
            type="text"
            value={login}
            onChange={(e) => { setLogin(e.target.value); setError(null); }}
            onKeyDown={handleKeyDown}
            placeholder="ivan.petrov"
            autoFocus
            disabled={isLoading}
            autoComplete="username"
            className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 mb-3"
          />

          <label className="block text-xs font-medium text-gray-500 mb-1.5">
            Пароль
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(null); }}
            onKeyDown={handleKeyDown}
            placeholder="••••••••"
            disabled={isLoading}
            autoComplete="current-password"
            className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 mb-1"
          />

          {error && (
            <p className="text-xs text-red-600 mt-1.5 mb-1">{error}</p>
          )}

          <Button
            variant="ai"
            onClick={handleRegister}
            disabled={isLoading || login.trim().length < 2 || password.length < 1}
            className="w-full mt-4 h-10"
          >
            {isLoading ? (
              <>
                <Loader2 className="animate-spin" />
                Вхожу...
              </>
            ) : (
              <>
                Войти
                <ArrowRight />
              </>
            )}
          </Button>

          <button
            onClick={onDone}
            disabled={isLoading}
            className="w-full mt-2 h-9 text-sm text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50"
          >
            Пропустить (настроить позже)
          </button>
        </div>

        {serverUrl && (
          <p className="text-center text-xs text-gray-400 mt-4">
            Сервер: {serverUrl}
          </p>
        )}
      </div>
    </div>
  );
}
