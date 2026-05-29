"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Loader2, RefreshCw, Server, KeyRound, Cloud, CloudOff, CloudCog, Trash2, UserCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { NotificationPermissionCard } from "./NotificationPermissionCard";

/** Поле ввода нового API-ключа + кнопка Сохранить */
function ApiKeyInput({ onSaved }: { onSaved: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error("Введи ключ");
      return;
    }
    setIsSaving(true);
    try {
      await invoke("insapp_set_api_key", { apiKey: trimmed });
      toast.success("API-ключ сохранён");
      setValue("");
      await onSaved();
    } catch (e) {
      toast.error("Не удалось сохранить ключ", { description: String(e) });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type={showKey ? "text" : "password"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Вставь сюда API-ключ от сервера Insapp"
        className="flex-1 px-3 py-2 border border-gray-300 rounded-md font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
        }}
      />
      <button
        type="button"
        onClick={() => setShowKey((v) => !v)}
        className="text-xs text-gray-500 hover:text-gray-700 px-2"
      >
        {showKey ? "Скрыть" : "Показать"}
      </button>
      <Button size="sm" onClick={handleSave} disabled={isSaving || !value.trim()}>
        {isSaving && <Loader2 className="w-3 h-3 mr-2 animate-spin" />}
        Сохранить
      </Button>
    </div>
  );
}

interface InsappServerSettings {
  server_url: string;
  auto_upload: boolean;
}

interface InsappServerStatus {
  settings: InsappServerSettings;
  api_key_preview: string;
  key_source: string; // "none" | "user"
  queue_size: number;
  server_reachable: boolean | null;
  full_name: string;
  is_registered: boolean;
}

/** Блок регистрации: ввод ФИО → персональный ключ от сервера */
function RegistrationBlock({
  status,
  onChanged,
}: {
  status: InsappServerStatus | null;
  onChanged: () => Promise<void>;
}) {
  const [fullName, setFullName] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);

  const handleRegister = async () => {
    const name = fullName.trim();
    if (name.length < 2) {
      toast.error("Введи имя и фамилию");
      return;
    }
    setIsRegistering(true);
    try {
      await invoke("insapp_register_with_server", { fullName: name });
      toast.success(`Готово, ${name} - ключ создан`);
      setFullName("");
      await onChanged();
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as any)?.message || String(e);
      toast.error("Не удалось зарегистрироваться", { description: msg });
    } finally {
      setIsRegistering(false);
    }
  };

  if (status?.is_registered) {
    return (
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600 mb-0.5">Ты вошёл как</p>
          <p className="text-base font-semibold text-gray-900">{status.full_name || "—"}</p>
          <p className="text-xs text-gray-500 mt-1">
            Встречи на сервере подписаны твоим именем.
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-400 mb-2">
            Ключ:{" "}
            <code className="px-1.5 py-0.5 bg-gray-100 rounded font-mono">
              {status.api_key_preview}
            </code>
          </p>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Сменить имя"
            className="w-40 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 mr-2"
            onKeyDown={(e) => { if (e.key === "Enter") handleRegister(); }}
          />
          <Button size="sm" variant="outline" onClick={handleRegister} disabled={isRegistering || fullName.trim().length < 2}>
            {isRegistering && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
            Перерегистрировать
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-gray-600 mb-3">
        Введи имя и фамилию - сервер создаст тебе персональный ключ, и твои
        встречи будут подписаны в общих отчётах.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Иван Иванов"
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          onKeyDown={(e) => { if (e.key === "Enter") handleRegister(); }}
        />
        <Button onClick={handleRegister} disabled={isRegistering || fullName.trim().length < 2}>
          {isRegistering && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Зарегистрироваться
        </Button>
      </div>
    </div>
  );
}

export function InsappServerSettings() {
  const [status, setStatus] = useState<InsappServerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isFlushing, setIsFlushing] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const [serverUrl, setServerUrl] = useState("http://localhost:8080");
  const [autoUpload, setAutoUpload] = useState(true);

  const loadStatus = async () => {
    try {
      const s = await invoke<InsappServerStatus>("insapp_get_status");
      setStatus(s);
      setServerUrl(s.settings.server_url);
      setAutoUpload(s.settings.auto_upload);
    } catch (e) {
      console.error("Не удалось получить статус сервера:", e);
      toast.error("Не удалось получить статус сервера", {
        description: String(e),
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await invoke("insapp_save_settings", {
        serverUrl: serverUrl.trim(),
        autoUpload,
      });
      toast.success("Настройки сохранены");
      await loadStatus();
    } catch (e) {
      toast.error("Не удалось сохранить настройки", {
        description: String(e),
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Удалить текущий ключ (если пользователь хочет очистить и ввести заново)
  const handleClearKey = async () => {
    if (!confirm("Удалить текущий API-ключ?")) return;
    setIsRegenerating(true);
    try {
      await invoke<string>("insapp_regenerate_api_key");
      toast.success("Ключ удалён - введи новый");
      await loadStatus();
    } catch (e) {
      toast.error("Не удалось удалить ключ", {
        description: String(e),
      });
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleFlushQueue = async () => {
    setIsFlushing(true);
    try {
      const result = await invoke<{ sent: number; pending: number; failed: number }>(
        "insapp_flush_queue",
      );
      if (result.sent > 0) {
        toast.success(`Отправлено ${result.sent} встреч`, {
          description:
            result.pending > 0
              ? `Ещё ${result.pending} ждут в очереди (сервер недоступен)`
              : undefined,
        });
      } else if (result.pending > 0) {
        toast.warning(`${result.pending} встреч в очереди - сервер недоступен`);
      } else if (result.failed > 0) {
        toast.error(`Ошибка отправки ${result.failed} встреч`);
      } else {
        toast.success("Очередь пуста");
      }
      await loadStatus();
    } catch (e) {
      toast.error("Не удалось отправить очередь", {
        description: String(e),
      });
    } finally {
      setIsFlushing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 p-6">
        <Loader2 className="w-4 h-4 animate-spin" />
        Загружаю настройки сервера...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Системные уведомления - явная кнопка чтобы macOS показал grant-диалог */}
      <NotificationPermissionCard />

      {/* Статус подключения */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {status?.server_reachable === true ? (
              <Cloud className="w-6 h-6 text-green-600" />
            ) : status?.server_reachable === false ? (
              <CloudOff className="w-6 h-6 text-red-500" />
            ) : (
              <CloudCog className="w-6 h-6 text-gray-400" />
            )}
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Корпоративный сервер Insapp</h3>
              <p className="text-sm text-gray-600">
                {status?.server_reachable === true
                  ? "Сервер доступен - встречи уходят сразу"
                  : status?.server_reachable === false
                    ? "Сервер недоступен - встречи копятся в очереди"
                    : "Проверяю доступность..."}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={loadStatus} title="Обновить статус">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        {status && status.queue_size > 0 && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-md flex items-center justify-between">
            <p className="text-sm text-amber-800">
              В очереди ждут отправки: <strong>{status.queue_size}</strong>
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleFlushQueue}
              disabled={isFlushing}
            >
              {isFlushing ? (
                <Loader2 className="w-3 h-3 mr-2 animate-spin" />
              ) : (
                <Cloud className="w-3 h-3 mr-2" />
              )}
              Отправить сейчас
            </Button>
          </div>
        )}
      </div>

      {/* Адрес сервера */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <Server className="w-5 h-5 text-gray-600 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-gray-900 mb-1">Адрес сервера</h3>
            <p className="text-sm text-gray-600 mb-3">
              Куда отправлять транскрипты. Локально - http://localhost:8080
            </p>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://localhost:8080"
              className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <div>
            <p className="font-medium text-gray-900">Автоматически отправлять</p>
            <p className="text-sm text-gray-600">Загружать транскрипт на сервер сразу после встречи</p>
          </div>
          <Switch checked={autoUpload} onCheckedChange={setAutoUpload} />
        </div>

        <div className="mt-4 flex justify-end">
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Сохранить
          </Button>
        </div>
      </div>

      {/* Регистрация / кто вошёл */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <UserCircle className="w-5 h-5 text-gray-600 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-gray-900 mb-3">
              {status?.is_registered ? "Учётная запись" : "Регистрация на сервере"}
            </h3>
            <RegistrationBlock status={status} onChanged={loadStatus} />
          </div>
        </div>
      </div>

      {/* Ручной ввод ключа - для редких случаев когда админ выдал ключ напрямую */}
      <details className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <summary className="flex items-center gap-3 cursor-pointer text-sm text-gray-500 hover:text-gray-700">
          <KeyRound className="w-4 h-4" />
          Ввести API-ключ вручную (если выдал админ)
        </summary>
        <div className="mt-4">
          <ApiKeyInput
            onSaved={async () => {
              await loadStatus();
            }}
          />
        </div>
      </details>
    </div>
  );
}
