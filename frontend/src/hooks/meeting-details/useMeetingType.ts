import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type MeetingKind = 'internal' | 'external';

/**
 * Тип встречи: внутренняя / внешняя. Сохраняется в базе (api_set_meeting_type) и сразу
 * уезжает на сервер - переотправка встречи обновляет плашку типа на дашборде.
 * (Логика перенесена без изменений из SummaryPanel; добавлен явный выбор значения.)
 */
export function useMeetingType(meetingId: string, initial?: string) {
  const [meetingType, setMeetingTypeState] = useState<MeetingKind>(initial === 'external' ? 'external' : 'internal');

  // Встреча сменилась или backend вернул иной тип - синхронизируем.
  useEffect(() => {
    setMeetingTypeState(initial === 'external' ? 'external' : 'internal');
  }, [meetingId, initial]);

  const setMeetingType = useCallback(async (next: MeetingKind) => {
    const prev = meetingType;
    if (next === prev) return;
    console.log('[insapp-meet] meet: set-type', next);
    setMeetingTypeState(next); // оптимистично обновляем UI
    try {
      await invoke('api_set_meeting_type', { meetingId, meetingType: next });
      // Синк типа на сервер: переотправляем встречу - meta включает meeting_type из БД,
      // дашборд обновляет тип по meeting_id. Без этого тип менялся только локально.
      try {
        await invoke('insapp_upload_meeting_by_id', { meetingId });
        console.log('[insapp-meet] meet: тип синхронизирован на сервер ->', next);
      } catch (e) {
        console.warn('[insapp-meet] meet: не удалось синхронизировать тип на сервер', e);
      }
      window.dispatchEvent(new CustomEvent('meetings-refresh'));
    } catch (error) {
      console.error('[insapp-meet] meet: set-type failed, откат', error);
      setMeetingTypeState(prev); // откат к прежнему значению при ошибке
    }
  }, [meetingId, meetingType]);

  return { meetingType, setMeetingType };
}
