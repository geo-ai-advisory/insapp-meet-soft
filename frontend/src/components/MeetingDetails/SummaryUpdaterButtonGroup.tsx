"use client";

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, Save, Loader2, Search, FolderOpen, Link2, Check } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { useState } from 'react';
import { toast } from 'sonner';

interface SummaryUpdaterButtonGroupProps {
  isSaving: boolean;
  isDirty: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  onFind?: () => void;
  onOpenFolder: () => Promise<void>;
  hasSummary: boolean;
  /** id встречи - нужен, чтобы получить ссылку «Поделиться». */
  meetingId?: string;
}

export function SummaryUpdaterButtonGroup({
  isSaving,
  isDirty,
  onSave,
  onCopy,
  onFind,
  onOpenFolder,
  hasSummary,
  meetingId
}: SummaryUpdaterButtonGroupProps) {
  // «Поделиться»: получаем публичную ссылку на встречу и кладём в буфер обмена.
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);

  const handleShare = async () => {
    if (!meetingId || sharing) return;
    setSharing(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ url?: string }>('insapp_share_meeting', { meetingId });
      const url = res?.url;
      if (!url) throw new Error('сервер не вернул ссылку');
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 2500);
      toast.success('Ссылка скопирована', {
        description: 'Откроется у любого, кому её отправишь - пароль не нужен.',
      });
    } catch (e: any) {
      const msg = typeof e === 'string' ? e : (e?.message || 'не удалось получить ссылку');
      toast.error('Не получилось поделиться', { description: msg });
    } finally {
      setSharing(false);
    }
  };

  return (
    <ButtonGroup>
      {/* Save button */}
      <Button
        variant="outline"
        size="sm"
        className={`${isDirty ? 'bg-green-200' : ""}`}
        title={isSaving ? "Сохраняю..." : "Сохранить изменения"}
        onClick={() => {
          Analytics.trackButtonClick('save_changes', 'meeting_details');
          onSave();
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <>
            <Loader2 className="animate-spin" />
            <span className="hidden lg:inline">Сохраняю...</span>
          </>
        ) : (
          <>
            <Save />
            <span className="hidden lg:inline">Сохранить</span>
          </>
        )}
      </Button>

      {/* Copy button */}
      <Button
        variant="outline"
        size="sm"
        title="Скопировать резюме"
        onClick={() => {
          Analytics.trackButtonClick('copy_summary', 'meeting_details');
          onCopy();
        }}
        disabled={!hasSummary}
        className="cursor-pointer"
      >
        <Copy />
        <span className="hidden lg:inline">Скопировать</span>
      </Button>

      {/* Поделиться: публичная ссылка на встречу, открывается без пароля */}
      {meetingId && (
        <Button
          variant="outline"
          size="sm"
          title="Получить ссылку на встречу - откроется у любого без пароля"
          onClick={() => {
            Analytics.trackButtonClick('share_meeting', 'meeting_details');
            handleShare();
          }}
          disabled={sharing}
          className="cursor-pointer"
        >
          {sharing ? <Loader2 className="animate-spin" /> : shared ? <Check className="text-green-600" /> : <Link2 />}
          <span className="hidden lg:inline">{shared ? 'Скопировано' : 'Поделиться'}</span>
        </Button>
      )}

      {/* Find button */}
      {/* {onFind && (
        <Button
          variant="outline"
          size="sm"
          title="Find in Summary"
          onClick={() => {
            Analytics.trackButtonClick('find_in_summary', 'meeting_details');
            onFind();
          }}
          disabled={!hasSummary}
          className="cursor-pointer"
        >
          <Search />
          <span className="hidden lg:inline">Find</span>
        </Button>
      )} */}
    </ButtonGroup>
  );
}
