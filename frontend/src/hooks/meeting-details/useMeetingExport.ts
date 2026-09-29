import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { meetingFileName, stripTitleH1, summaryToTelegram } from '@/lib/meetingFormat';

/** Настоящее приложение (а не браузерный dev-стенд с моком движка). */
function isRealTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !(window as any).__INMEET_DEV_MOCK__;
}

async function copyRich(plain: string, html: string) {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return;
    }
  } catch { /* богатый буфер недоступен - обычный текст ниже */ }
  await navigator.clipboard.writeText(plain);
}

/**
 * «Скопировать для Telegram» и «Скачать .md» для резюме встречи.
 *
 * Telegram: заголовки и акценты жирным, пункты «•» - вставляется в чат без markdown-мусора.
 * .md: файл «<Название> - <дата>.md» в папку «Загрузки». В приложении - через плагин fs
 * (права на запись в «Загрузки» уже выданы в tauri.conf.json); если плагин недоступен,
 * текст .md кладётся в буфер и об этом честно говорится. В браузере - обычное скачивание.
 */
export function useMeetingExport({
  title, createdAt, markdown,
}: { title: string; createdAt: Date | null; markdown: string }) {
  const [copied, setCopied] = useState(false);

  const copyForTelegram = useCallback(async () => {
    if (!markdown.trim()) {
      toast.error('Резюме ещё нет', { description: 'Сначала сделайте резюме - потом его можно отправить в Telegram' });
      return;
    }
    const { plain, html } = summaryToTelegram(markdown, title);
    try {
      await copyRich(plain, html);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
      toast.success('Резюме скопировано', { description: 'Вставьте в Telegram - жирный и пункты сохранятся' });
    } catch (e) {
      toast.error('Не удалось скопировать', { description: String(e) });
    }
  }, [markdown, title]);

  const downloadMd = useCallback(async () => {
    if (!markdown.trim()) {
      toast.error('Резюме ещё нет', { description: 'Сначала сделайте резюме' });
      return;
    }
    const name = meetingFileName(title, createdAt);
    const content = `# ${title}\n\n${stripTitleH1(markdown).trim()}\n`;

    if (isRealTauri()) {
      try {
        const { writeTextFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(name, content, { baseDir: BaseDirectory.Download });
        toast.success('Файл сохранён в «Загрузки»', {
          description: name,
          action: {
            label: 'Показать',
            onClick: async () => {
              try {
                const { downloadDir } = await import('@tauri-apps/api/path');
                await invoke('open_external_url', { url: await downloadDir() });
              } catch { /* не открылось - файл всё равно в «Загрузках» */ }
            },
          },
        });
      } catch (e) {
        console.warn('[insapp-meet] .md: запись в «Загрузки» недоступна', e);
        try {
          await navigator.clipboard.writeText(content);
          toast.error('Не получилось сохранить файл', {
            description: 'Текст резюме в формате .md скопирован - вставьте его в любой редактор',
          });
        } catch {
          toast.error('Не получилось сохранить файл');
        }
      }
      return;
    }

    // Браузер (dev-стенд): обычное скачивание файла.
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast.success('Файл сохранён в «Загрузки»', { description: name });
  }, [markdown, title, createdAt]);

  return { copyForTelegram, downloadMd, copied };
}
