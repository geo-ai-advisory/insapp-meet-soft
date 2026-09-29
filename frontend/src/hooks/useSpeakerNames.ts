'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Имена участников, заданные ВО ВРЕМЯ записи (встречи в базе ещё нет).
 * Живут в сессии до сохранения встречи, потом переносятся в неё (storageService).
 */
export const LIVE_SPEAKER_NAMES_KEY = 'insapp_live_speaker_names';

/**
 * Новая запись - имена с прошлой (прерванной, несохранённой) записи не переносим:
 * номера голосов у новой записи свои, «Собеседник 1» там - уже другой человек.
 */
export function resetLiveSpeakerNames() {
  if (typeof window === 'undefined') return;
  try { sessionStorage.removeItem(LIVE_SPEAKER_NAMES_KEY); } catch { /* нет хранилища - нечего чистить */ }
}

/** Автоподпись голоса: "mic" -> «Вы», "system" -> «Собеседник», "system_N" -> «Собеседник N». */
export function speakerLabel(sp?: string): string | undefined {
  if (!sp) return undefined;
  if (sp === 'mic') return 'Вы';
  if (sp === 'system') return 'Собеседник';
  const guest = /^system_(\d+)$/.exec(sp);
  if (guest) return `Собеседник ${guest[1]}`;
  return sp;
}

export interface SpeakerNamesApi {
  /** Заданные пользователем (или узнанные по голосу) имена: "system_1" -> «Анна Смирнова». */
  names: Record<string, string>;
  /** Сохранить имя голоса (пустое имя - сбросить к автоподписи). */
  saveName: (key: string, name: string) => Promise<void>;
  /** Итоговая подпись: имя пользователя, иначе автоподпись («Вы» / «Собеседник N»). */
  labelFor: (sp?: string) => string | undefined;
}

/**
 * Имена участников встречи: загрузка, «голоса коллег» и сохранение.
 *
 * Логика перенесена без изменений из VirtualizedTranscriptView, чтобы имена были общими
 * у ленты реплик, строки участников и панели «Участники» главного экрана:
 *  - сохранённая встреча: имена из api_get_speaker_names, сохранение - api_set_speaker_name
 *    + переотправка встречи на сервер (дашборд и ссылка «Поделиться» видят новое имя);
 *  - идёт запись (meetingId нет): имена живут в sessionStorage, приложение присылает
 *    узнанные по голосу имена событием speakers-recognized - подставляем только тем,
 *    кого пользователь ещё не назвал, и только имена, которых ещё нет в этой встрече.
 *
 * enabled=false - хук ничего не грузит и не слушает (имена пришли снаружи).
 */
export function useSpeakerNames(meetingId?: string, enabled: boolean = true): SpeakerNamesApi {
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!enabled) return;
    // Идёт запись, встреча ещё не сохранена - имена живут в сессии.
    // Так участника можно назвать прямо во время разговора, и все его
    // реплики (уже сказанные и будущие) сразу идут под этим именем.
    if (!meetingId) {
      if (typeof window !== 'undefined') {
        try {
          const raw = sessionStorage.getItem(LIVE_SPEAKER_NAMES_KEY);
          if (raw) setNames(JSON.parse(raw));
        } catch { /* повреждённое значение - просто автоподписи */ }
      }
      return;
    }
    let alive = true;
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<Record<string, string>>('api_get_speaker_names', { meetingId }))
      .then((n) => { if (alive && n) setNames(n); })
      .catch(() => { /* имён ещё нет - показываем автоподписи */ });
    return () => { alive = false; };
  }, [meetingId, enabled]);

  // Голоса коллег: во время записи приложение узнаёт собеседников по голосам из прошлых
  // встреч (имя, данное человеку раньше) и присылает имена. Подставляем только тем, кого
  // пользователь ещё не назвал, и только имена, которых ещё нет в этой встрече.
  useEffect(() => {
    if (!enabled || meetingId) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ items: { speaker: string; name: string }[] }>('speakers-recognized', (event) => {
          const items = event.payload?.items || [];
          if (items.length === 0) return;
          setNames((prev) => {
            const used = new Set(Object.values(prev).map((n) => n.trim().toLowerCase()));
            let next: Record<string, string> | null = null;
            for (const it of items) {
              if (!it.speaker || !it.name || prev[it.speaker]) continue;
              if (used.has(it.name.trim().toLowerCase())) continue;
              next = next || { ...prev };
              next[it.speaker] = it.name;
              used.add(it.name.trim().toLowerCase());
            }
            if (!next) return prev;
            try {
              sessionStorage.setItem(LIVE_SPEAKER_NAMES_KEY, JSON.stringify(next));
            } catch { /* не сохранилось - имя всё равно видно на экране */ }
            return next;
          });
        }),
      )
      .then((fn) => { if (alive) unlisten = fn; else fn(); })
      .catch(() => { /* dev-браузер без движка */ });
    return () => { alive = false; if (unlisten) unlisten(); };
  }, [meetingId, enabled]);

  const saveName = useCallback(async (key: string, name: string) => {
    setNames((prev) => {
      const next = { ...prev };
      if (name.trim()) next[key] = name.trim(); else delete next[key];
      return next;
    });

    // Запись идёт, встречи в базе ещё нет: запоминаем в сессии.
    // При сохранении встречи эти имена перенесутся в неё (см. storageService).
    if (!meetingId) {
      if (typeof window !== 'undefined') {
        try {
          const raw = sessionStorage.getItem(LIVE_SPEAKER_NAMES_KEY);
          const map: Record<string, string> = raw ? JSON.parse(raw) : {};
          if (name.trim()) map[key] = name.trim(); else delete map[key];
          sessionStorage.setItem(LIVE_SPEAKER_NAMES_KEY, JSON.stringify(map));
        } catch { /* не сохранилось - имя всё равно видно на экране */ }
      }
      return;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('api_set_speaker_name', { meetingId, speakerKey: key, displayName: name.trim() });
      // Обновляем встречу на сервере, иначе в дашборде и по ссылке
      // «Поделиться» осталась бы прежняя подпись («Собеседник 1»).
      // Встречи, помеченные «только локально», команда не тронет.
      try {
        await invoke('insapp_upload_meeting_by_id', { meetingId });
      } catch (e) {
        console.warn('[insapp-meet] имя сохранено локально, на сервере обновится позже', e);
      }
    } catch (e) {
      console.warn('[insapp-meet] не удалось сохранить имя участника', e);
    }
  }, [meetingId]);

  const labelFor = useCallback(
    (sp?: string) => (sp && names[sp]) || speakerLabel(sp),
    [names],
  );

  // Один и тот же объект, пока имена не менялись, - лента не перерисовывается от тиков таймера записи.
  return useMemo(() => ({ names, saveName, labelFor }), [names, saveName, labelFor]);
}
