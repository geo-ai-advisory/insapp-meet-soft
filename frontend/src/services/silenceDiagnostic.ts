import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

interface AudioLevelData {
  device_name: string;
  device_type: string; // "input" (микрофон) | "output" (системный звук)
  rms_level: number;
  peak_level: number;
  is_active: boolean;
}
interface AudioLevelUpdate {
  timestamp: number;
  levels: AudioLevelData[];
}

/**
 * Самодиагностика записи звука.
 *
 * Слушает поток уровней ('audio-levels') всю запись и копит максимум RMS
 * отдельно по микрофону (input) и системному звуку (output). При остановке,
 * если за всю запись источник молчал (RMS остался около нуля), отправляет
 * диагностику на сервер командой send_audio_diagnostic.
 *
 * Нужно, чтобы удалённо видеть случаи, когда запись идёт, но звук не
 * захватывается БЕЗ ошибки в приложении (частый случай на Windows: система
 * после обновления молча отзывает доступ к микрофону у классических
 * приложений). Пользователь ничего не делает - данные уходят сами.
 */
class SilenceDiagnostic {
  private unlisten: UnlistenFn | null = null;
  private startedAt = 0;
  private micMaxRms = 0;
  private systemMaxRms = 0;
  private micDevice = '';
  private systemDevice = '';
  private levelEvents = 0;

  /** Начать накопление уровней. Вызывается при старте записи. */
  async start(): Promise<void> {
    await this.stopListening();
    this.startedAt = Date.now();
    this.micMaxRms = 0;
    this.systemMaxRms = 0;
    this.micDevice = '';
    this.systemDevice = '';
    this.levelEvents = 0;
    try {
      this.unlisten = await listen<AudioLevelUpdate>('audio-levels', (event) => {
        const update = event.payload;
        if (!update?.levels) return;
        this.levelEvents += 1;
        for (const lvl of update.levels) {
          if (lvl.device_type === 'input') {
            if (lvl.rms_level > this.micMaxRms) this.micMaxRms = lvl.rms_level;
            if (lvl.device_name) this.micDevice = lvl.device_name;
          } else if (lvl.device_type === 'output') {
            if (lvl.rms_level > this.systemMaxRms) this.systemMaxRms = lvl.rms_level;
            if (lvl.device_name) this.systemDevice = lvl.device_name;
          }
        }
      });
    } catch (e) {
      console.warn('[insapp-meet] диагностика звука: не удалось подписаться на уровни', e);
    }
  }

  /** Остановить накопление и, если была тишина, отправить диагностику на сервер. */
  async stopAndReport(): Promise<void> {
    await this.stopListening();
    if (this.startedAt === 0) return;
    const durationSec = (Date.now() - this.startedAt) / 1000;
    this.startedAt = 0;
    // Слишком короткая запись - не делаем выводов о тишине.
    if (durationSec < 3) return;
    try {
      // Команда сама решает, есть ли проблема (порог тишины) и слать ли на сервер.
      await invoke('send_audio_diagnostic', {
        micDevice: this.micDevice,
        systemDevice: this.systemDevice,
        micMaxRms: this.micMaxRms,
        systemMaxRms: this.systemMaxRms,
        levelEvents: this.levelEvents,
        durationSec,
      });
    } catch (e) {
      console.warn('[insapp-meet] диагностика звука: не удалось отправить', e);
    }
  }

  private async stopListening(): Promise<void> {
    if (this.unlisten) {
      try { this.unlisten(); } catch { /* ignore */ }
      this.unlisten = null;
    }
  }
}

export const silenceDiagnostic = new SilenceDiagnostic();
