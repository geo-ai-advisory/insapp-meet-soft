/**
 * Storage Service
 *
 * Handles all meeting storage and retrieval Tauri backend calls (SQLite persistence).
 * Pure 1-to-1 wrapper - no error handling changes, exact same behavior as direct invoke calls.
 */

import { invoke } from '@tauri-apps/api/core';
import { Transcript } from '@/types';
import { LIVE_SPEAKER_NAMES_KEY } from '@/components/VirtualizedTranscriptView';

export interface SaveMeetingRequest {
  meetingTitle: string;
  transcripts: Transcript[];
  folderPath: string | null;
}

export interface SaveMeetingResponse {
  meeting_id: string;
}

export interface Meeting {
  id: string;
  title: string;
  [key: string]: any; // Allow additional properties from backend
}

/**
 * Storage Service
 * Singleton service for managing meeting storage operations
 */
export class StorageService {
  /**
   * Save meeting transcript to SQLite database
   * @param meetingTitle - Title of the meeting
   * @param transcripts - Array of transcript segments
   * @param folderPath - Optional folder path for audio file
   * @returns Promise with { meeting_id: string }
   */
  async saveMeeting(
    meetingTitle: string,
    transcripts: Transcript[],
    folderPath: string | null
  ): Promise<SaveMeetingResponse> {
    // Читаем галочку «Отправить в облако Insapp» из sessionStorage
    // (UploadOptInToggle сохраняет туда состояние)
    let skipServerUpload = false;
    if (typeof window !== 'undefined') {
      const stored = sessionStorage.getItem('insapp_upload_to_cloud');
      skipServerUpload = stored === 'false';
    }

    const res = await invoke<SaveMeetingResponse>('api_save_transcript', {
      meetingTitle,
      transcripts,
      folderPath,
      skipServerUpload,
    });

    // Переносим во встречу имена участников, заданные ВО ВРЕМЯ записи.
    //
    // Пока шла запись, встречи в базе не было, поэтому имена лежали в сессии.
    // Теперь у встречи есть id - записываем их к ней, иначе после сохранения
    // подписи откатились бы к «Собеседник 1».
    const meetingId = (res as any)?.meeting_id;
    if (meetingId && typeof window !== 'undefined') {
      try {
        const raw = sessionStorage.getItem(LIVE_SPEAKER_NAMES_KEY);
        const map: Record<string, string> = raw ? JSON.parse(raw) : {};
        const keys = Object.keys(map);
        if (keys.length > 0) {
          for (const key of keys) {
            await invoke('api_set_speaker_name', { meetingId, speakerKey: key, displayName: map[key] });
          }
          // Перезаливаем встречу на сервер - чтобы в дашборде и по ссылке
          // «Поделиться» были имена, а не автоподписи.
          if (!skipServerUpload) {
            try { await invoke('insapp_upload_meeting_by_id', { meetingId }); } catch { /* уедет позже */ }
          }
        }
        sessionStorage.removeItem(LIVE_SPEAKER_NAMES_KEY);
      } catch (e) {
        console.warn('[insapp-meet] не удалось перенести имена участников во встречу', e);
      }
    }

    return res;
  }

  /**
   * Get meeting details by ID
   * @param meetingId - ID of the meeting to fetch
   * @returns Promise with meeting details
   */
  async getMeeting(meetingId: string): Promise<Meeting> {
    return invoke<Meeting>('api_get_meeting', { meetingId });
  }

  /**
   * Get list of all meetings
   * @returns Promise with array of meetings
   */
  async getMeetings(): Promise<Meeting[]> {
    return invoke<Meeting[]>('api_get_meetings');
  }
}

// Export singleton instance
export const storageService = new StorageService();
