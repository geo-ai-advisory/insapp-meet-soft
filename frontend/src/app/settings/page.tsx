'use client';

import React, { useState, useEffect } from 'react';
import { ArrowLeft, Settings2, Mic, MicOff, Database as DatabaseIcon, SparkleIcon, FlaskConical, Cloud, UserRound, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { PreferenceSettings } from '@/components/PreferenceSettings';
import { BetaSettings } from '@/components/BetaSettings';
import { InsappServerSettings } from '@/components/InsappServerSettings';
import { AiSummarySettings } from '@/components/AiSummarySettings';
import { MicIgnoredAppsSettings } from '@/components/MicIgnoredAppsSettings';
import { useConfig } from '@/contexts/ConfigContext';

/**
 * Настройки - единый скролл-список секций-карточек (как в макете Insapp Pro, вариант B),
 * а НЕ горизонтальные вкладки (был старый вид Meetily). Каждая секция: иконка + заголовок
 * + описание, внутри - готовый под-компонент настроек (логика не тронута). Первая секция -
 * Аккаунт (профиль на сервере Insapp + выход).
 */

// Секция-карточка единого стиля.
function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

// Секция «Аккаунт»: профиль на сервере Insapp + выход.
function AccountSection() {
  const [identity, setIdentity] = useState<{ full_name?: string; is_registered?: boolean } | null>(null);
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => {
    invoke<{ full_name?: string; is_registered?: boolean }>('insapp_get_identity')
      .then(setIdentity).catch(() => {});
    invoke<{ settings: { server_url: string } }>('insapp_get_status')
      .then((s) => setServerUrl(s?.settings?.server_url || '')).catch(() => {});
  }, []);

  const name = (identity?.full_name || '').trim();
  const initials = name ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : 'IN';
  const registered = !!identity?.is_registered;

  return (
    <SettingsSection icon={UserRound} title="Аккаунт" description="Вход на сервере Insapp">
      <div className="flex items-center gap-3.5">
        <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[hsl(var(--brand-blue))] text-[13px] font-semibold text-white">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{name || 'Вход не выполнен'}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            {registered ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="truncate">Подключено{serverUrl ? ` · ${serverUrl.replace(/^https?:\/\//, '')}` : ''}</span>
              </>
            ) : (
              <span>Нажми «Войти», чтобы синхронизировать встречи</span>
            )}
          </div>
        </div>
        {registered && (
          <button
            onClick={() => invoke('insapp_logout').catch(() => {})}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-[hsl(var(--brand-red))] transition-colors hover:bg-[hsl(var(--brand-red))]/10"
          >
            <LogOut className="h-4 w-4" />
            Выйти
          </button>
        )}
      </div>
    </SettingsSection>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { transcriptModelConfig, setTranscriptModelConfig } = useConfig();

  // Load saved transcript configuration on mount
  useEffect(() => {
    const loadTranscriptConfig = async () => {
      try {
        const config = await invoke('api_get_transcript_config') as any;
        if (config) {
          setTranscriptModelConfig({
            provider: config.provider || 'localWhisper',
            model: config.model || 'large-v3',
            apiKey: config.apiKey || null,
          });
        }
      } catch (error) {
        console.error('Failed to load transcript config:', error);
      }
    };
    loadTranscriptConfig();
  }, [setTranscriptModelConfig]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Шапка */}
      <div className="sticky top-0 z-10 flex-none border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-8 py-5">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground no-drag"
          >
            <ArrowLeft className="h-[18px] w-[18px]" />
            Назад
          </button>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">Настройки</h1>
            <p className="text-[12.5px] text-muted-foreground">Аккаунт, запись звука, модели и обновления Insapp-meet</p>
          </div>
        </div>
      </div>

      {/* Единый список секций */}
      <div className="custom-scrollbar flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-8 py-6">
          <AccountSection />

          <SettingsSection icon={Cloud} title="Сервер Insapp" description="Куда отправляются записи и резюме">
            <InsappServerSettings />
          </SettingsSection>

          <SettingsSection icon={Mic} title="Запись" description="Источники звука и сохранение по умолчанию">
            <RecordingSettings />
          </SettingsSection>

          <SettingsSection icon={DatabaseIcon} title="Распознавание" description="Движок и модели транскрипции">
            <TranscriptSettings
              transcriptModelConfig={transcriptModelConfig}
              setTranscriptModelConfig={setTranscriptModelConfig}
            />
          </SettingsSection>

          <SettingsSection icon={SparkleIcon} title="AI-резюме" description="Модель и ключи для генерации резюме">
            <AiSummarySettings />
          </SettingsSection>

          <SettingsSection icon={Settings2} title="Общие" description="Уведомления и хранение">
            <PreferenceSettings />
          </SettingsSection>

          <SettingsSection icon={MicOff} title="Игнор микрофона" description="Приложения, которые не запускают авто-запись">
            <MicIgnoredAppsSettings />
          </SettingsSection>

          <SettingsSection icon={FlaskConical} title="Бета" description="Экспериментальные функции">
            <BetaSettings />
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
