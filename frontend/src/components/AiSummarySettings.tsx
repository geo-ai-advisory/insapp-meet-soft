"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Loader2, Terminal, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "./ui/button";

interface AiSummarySettings {
  provider: string;
  command: string;
  args: string[];
  format: string;
  prompt_template: string;
  use_print_mode: boolean;
}

export function AiSummarySettings() {
  const [settings, setSettings] = useState<AiSummarySettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [cliPath, setCliPath] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = async () => {
    try {
      const s = await invoke<AiSummarySettings>("ai_summary_get_settings");
      setSettings(s);
      checkCli(s.command);
    } catch (e) {
      console.error(e);
      toast.error("Не удалось загрузить настройки AI-резюме");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const checkCli = async (cmd: string) => {
    if (!cmd) return;
    setChecking(true);
    try {
      const path = await invoke<string | null>("ai_summary_check_cli", { command: cmd });
      setCliPath(path);
    } catch (_) {
      setCliPath(null);
    } finally {
      setChecking(false);
    }
  };

  const handleProviderChange = (provider: string) => {
    if (!settings) return;
    const cmd = provider === "claude" ? "claude" : provider === "codex" ? "codex" : settings.command;
    const updated = { ...settings, provider, command: cmd };
    setSettings(updated);
    checkCli(cmd);
  };

  const handleSave = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      console.log('[insapp-meet] settings: сохранение настроек AI-резюме');
      await invoke("ai_summary_save_settings", { settings });
      toast.success("Настройки сохранены");
      checkCli(settings.command);
    } catch (e) {
      toast.error("Не удалось сохранить", { description: String(e) });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !settings) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground p-6">
        <Loader2 className="w-4 h-4 animate-spin" />
        Загружаю настройки...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="bg-card rounded-lg border border-border p-6 shadow-sm">
        <div className="flex items-start gap-3 mb-5">
          <Terminal className="w-5 h-5 text-muted-foreground mt-0.5" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-foreground">Терминал для AI-резюме</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Когда нажимаешь «Сделать резюме» в карточке встречи - открывается встроенный терминал
              и запускается выбранный CLI с транскриптом.
            </p>
          </div>
        </div>

        {/* Provider selector */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Команда</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: "claude", label: "Claude Code" },
                { value: "codex", label: "Codex CLI" },
                { value: "custom", label: "Своя команда" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleProviderChange(opt.value)}
                  className={`px-4 py-2 text-sm rounded-md border transition-colors ${
                    settings.provider === opt.value
                      ? "border-primary bg-accent text-accent-foreground font-medium"
                      : "border-border text-foreground hover:bg-secondary"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {settings.provider === "custom" && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Путь к команде или имя в PATH
              </label>
              <input
                type="text"
                value={settings.command}
                onChange={(e) => {
                  const updated = { ...settings, command: e.target.value };
                  setSettings(updated);
                }}
                onBlur={() => checkCli(settings.command)}
                placeholder="/usr/local/bin/моя-обёртка"
                className="w-full px-3 py-2 border border-border bg-card text-foreground rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}

          {/* CLI check status */}
          <div
            className={`flex items-center gap-2 text-sm p-3 rounded-md ${
              checking
                ? "bg-secondary text-muted-foreground"
                : cliPath
                  ? "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300"
                  : "bg-destructive/10 text-destructive"
            }`}
          >
            {checking ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Проверяю наличие команды...
              </>
            ) : cliPath ? (
              <>
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  Команда найдена: <code className="font-mono text-xs">{cliPath}</code>
                </span>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4" />
                <span>
                  Команда <code className="font-mono">{settings.command}</code> не найдена в PATH
                </span>
              </>
            )}
          </div>

          {/* Format */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Формат транскрипта</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "markdown", label: "Markdown (простой текст)" },
                { value: "json", label: "JSON (с тайм-кодами)" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSettings({ ...settings, format: opt.value })}
                  className={`px-4 py-2 text-sm rounded-md border transition-colors ${
                    settings.format === opt.value
                      ? "border-primary bg-accent text-accent-foreground font-medium"
                      : "border-border text-foreground hover:bg-secondary"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Print mode (для Claude) */}
          {settings.provider === "claude" && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.use_print_mode}
                onChange={(e) =>
                  setSettings({ ...settings, use_print_mode: e.target.checked })
                }
                className="mt-0.5 accent-primary"
              />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Использовать флаг <code>--print</code>
                </p>
                <p className="text-xs text-muted-foreground">
                  Выведет ответ сразу и выйдет, без интерактивного режима
                </p>
              </div>
            </label>
          )}

          {/* Prompt */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Шаблон промпта</label>
            <textarea
              value={settings.prompt_template}
              onChange={(e) =>
                setSettings({ ...settings, prompt_template: e.target.value })
              }
              rows={6}
              className="w-full px-3 py-2 border border-border bg-card text-foreground rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Промпт для AI..."
            />
            <p className="text-xs text-muted-foreground mt-1">
              Можно использовать <code>{"{title}"}</code> и <code>{"{file}"}</code> -
              они заменятся на название встречи и путь к транскрипту.
            </p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Сохранить
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
