'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Имена участников, заданные ВО ВРЕМЯ записи (встречи в базе ещё нет).
 * Живут в сессии до сохранения встречи, потом переносятся в неё (storageService).
 */
export const LIVE_SPEAKER_NAMES_KEY = 'insapp_live_speaker_names';

/**
 * Номера голосов, которым имя во время записи подставило узнавание по голосу (а не пользователь).
 * Такое имя угадано по первым секундам речи, пока разметка голосов ещё плывёт; при сохранении
 * приложение узнаёт голоса заново по всей записи, и его ответ главнее (см. pickLiveNamesToSave).
 */
export const LIVE_SPEAKER_AUTO_KEY = 'insapp_live_speaker_names_auto';

export function readLiveAutoKeys(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const v = JSON.parse(sessionStorage.getItem(LIVE_SPEAKER_AUTO_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeLiveAutoKeys(keys: string[]) {
  try { sessionStorage.setItem(LIVE_SPEAKER_AUTO_KEY, JSON.stringify(Array.from(new Set(keys)))); } catch { /* имя всё равно видно на экране */ }
}

/**
 * Какие имена из записи переносить в сохранённую встречу.
 * Имя, данное пользователем, - всегда. Имя, угаданное по голосу во время записи, - только если
 * окончательное узнавание при сохранении этого собеседника не назвало и такого имени во встрече ещё
 * нет. Geo 28.10: в начале записи номер 1 узнался по голосу как коллега, потом разметка отдала этот
 * номер гостю со стороны партнёра; при сохранении приложение верно узнало гостя (0.90), но перенос живых
 * имён перезаписал его именем коллеги - во встрече стало два одинаковых имени, резюме приписало чужие слова.
 */
export function pickLiveNamesToSave(
  live: Record<string, string>,
  autoKeys: string[],
  saved: Record<string, string>,
): [string, string][] {
  const auto = new Set(autoKeys);
  const used = new Set(Object.values(saved).map((n) => n.trim().toLowerCase()));
  const out: [string, string][] = [];
  for (const [key, name] of Object.entries(live)) {
    if (!name.trim()) continue;
    if (auto.has(key) && (saved[key] || used.has(name.trim().toLowerCase()))) continue;
    out.push([key, name]);
    used.add(name.trim().toLowerCase());
  }
  return out;
}

/**
 * Новая запись - имена с прошлой (прерванной, несохранённой) записи не переносим:
 * номера голосов у новой записи свои, «Собеседник 1» там - уже другой человек.
 */
export function resetLiveSpeakerNames() {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(LIVE_SPEAKER_NAMES_KEY);
    sessionStorage.removeItem(LIVE_SPEAKER_AUTO_KEY);
  } catch { /* нет хранилища - нечего чистить */ }
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
function readLiveNames(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(LIVE_SPEAKER_NAMES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {}; // повреждённое значение - просто автоподписи
  }
}

export function useSpeakerNames(meetingId?: string, enabled: boolean = true): SpeakerNamesApi {
  // Идёт запись - имена сразу из сессии: первым же делом они уходят приложению (см. ниже),
  // пустой список на долю секунды снял бы защиту имён при пересмотре разметки.
  const [names, setNames] = useState<Record<string, string>>(() => (enabled && !meetingId ? readLiveNames() : {}));

  useEffect(() => {
    if (!enabled) return;
    // Идёт запись, встреча ещё не сохранена - имена живут в сессии.
    // Так участника можно назвать прямо во время разговора, и все его
    // реплики (уже сказанные и будущие) сразу идут под этим именем.
    if (!meetingId) {
      setNames(readLiveNames());
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
            writeLiveAutoKeys([...readLiveAutoKeys(), ...Object.keys(next).filter((k) => !prev[k])]);
            return next;
          });
        }),
      )
      .then((fn) => { if (alive) unlisten = fn; else fn(); })
      .catch(() => { /* dev-браузер без движка */ });
    return () => { alive = false; if (unlisten) unlisten(); };
  }, [meetingId, enabled]);

  // Идёт запись: имена отдаём приложению. Раз в 30 с оно пересматривает, кто есть кто, и без
  // имён могло отдать голос названного человека другому номеру - имя оставалось на пустом
  // номере, человек пропадал из списка (Geo 02.10). С именами названный номер в приоритете.
  useEffect(() => {
    if (!enabled || meetingId) return;
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('diarization_set_live_names', { names }))
      .catch(() => { /* dev-браузер без движка или старое приложение - имена всё равно видны на экране */ });
  }, [names, meetingId, enabled]);

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
          // Назвал сам - имя пользователя, при сохранении оно главнее узнавания по голосу.
          writeLiveAutoKeys(readLiveAutoKeys().filter((k) => k !== key));
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
