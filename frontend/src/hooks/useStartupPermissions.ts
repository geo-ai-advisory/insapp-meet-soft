import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';

/** Событие для подсказки «Нет доступа к микрофону»: разрешения только что запрашивали - проверь заново. */
export const PERMISSIONS_CHANGED_EVENT = 'inmeet-permissions-changed';

/**
 * Ждём ответа в окне macOS «разрешить доступ к микрофону». Пока окно запроса на экране, окно приложения
 * теряет фокус; ответили - фокус вернулся. Если за 1,5 с фокус не ушёл, запроса не было (доступ уже решён).
 * Без этой паузы запрос системного звука шёл, пока висел запрос микрофона, и macOS его не показывала -
 * системный звук спрашивался только на первой записи (0.4.4).
 */
function waitForPromptAnswer(maxMs = 90_000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      clearTimeout(check);
      clearTimeout(limit);
      resolve();
    };
    const onFocus = () => { setTimeout(finish, 600); };
    const check = setTimeout(() => {
      if (document.hasFocus()) finish();
      else window.addEventListener('focus', onFocus);
    }, 1500);
    const limit = setTimeout(finish, maxMs);
  });
}

/**
 * Разрешения macOS - разом при первом запуске каждой версии приложения.
 *
 * Geo 30.09: «почему разом все нельзя было запросить при первом открытии». Сборки не подписаны
 * сертификатом Apple, поэтому после каждого обновления macOS спрашивает доступ заново - раньше
 * микрофон и системный звук спрашивались по одному и уже во время встречи. Теперь сразу при запуске:
 * сначала микрофон, после ответа на него - системный звук. Если доступ уже есть, окна не появляются.
 * Раз на версию (ключ в localStorage), во время записи не трогаем.
 */
export function useStartupPermissions(isRecording: boolean) {
  useEffect(() => {
    if (isRecording) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let key = 'startup_permissions_asked';
      try {
        key += `_${await getVersion()}`;
      } catch { /* браузерный стенд - версия не важна */ }
      try {
        if (localStorage.getItem(key)) return;
      } catch { /* нет хранилища - просто спросим */ }
      await invoke<boolean>('trigger_microphone_permission').catch(() => false);
      await waitForPromptAnswer();
      if (cancelled) return;
      await invoke<boolean>('trigger_system_audio_permission_command').catch(() => false);
      try {
        localStorage.setItem(key, '1');
      } catch { /* ignore */ }
      window.dispatchEvent(new Event(PERMISSIONS_CHANGED_EVENT));
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // только при запуске
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
