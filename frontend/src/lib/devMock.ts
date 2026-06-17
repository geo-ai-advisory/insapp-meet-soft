/**
 * DEV-МОК движка (Tauri) для браузерной вёрстки с демо-данными.
 *
 * Только для `npm run dev` в обычном браузере (без Tauri). Подменяет
 * window.__TAURI_INTERNALS__ так, чтобы invoke() возвращал реалистичные демо-данные
 * (встречи, транскрипт, профиль, устройства), а listen()/event не падали. Это позволяет
 * довести вёрстку ВСЕХ экранов 1:1 с макетом прямо в браузере. В собранном приложении
 * настоящий __TAURI_INTERNALS__ уже есть -> мок не ставится.
 */

const DEMO_MEETINGS = [
  { id: 'demo-1', title: 'Синк с продуктом', meeting_type: 'internal', minutesAgo: 60 * 22, duration: 42, preview: 'Обсудили запуск новой витрины МФО и распределение позиций. Решили вынести крупный оффер на последнюю строку.' },
  { id: 'demo-2', title: 'Разбор воронки МФО', meeting_type: 'internal', minutesAgo: 60 * 30, duration: 65, preview: 'Прошлись по падению переходов на прошлой неделе. Гипотеза - сломался один из ключей выдачи.' },
  { id: 'demo-3', title: 'Звонок с партнёром', meeting_type: 'external', minutesAgo: 60 * 24 * 5, duration: 28, preview: 'Партнёр прислал описание методов интеграции. Нужно свести их с нашим форматом витрины.' },
  { id: 'demo-4', title: 'Ретро спринта', meeting_type: 'internal', minutesAgo: 60 * 24 * 7, duration: 51, preview: 'Команда довольна темпом, но просит раньше получать макеты. Решили добавить промежуточный показ.' },
  { id: 'demo-5', title: '1-на-1 с дизайнером', meeting_type: 'internal', minutesAgo: 60 * 24 * 10, duration: 33, preview: 'Обсудили загрузку и приоритеты на месяц. Дизайнер берёт редизайн экрана записи.' },
];

const DEMO_TRANSCRIPT = [
  { id: 1, timestamp: '00:00', speaker: 'Geo', text: 'Так, все слышно? Отлично. Сегодня хочу разобрать запуск новой витрины и как мы расставляем позиции МФО.' },
  { id: 2, timestamp: '00:14', speaker: 'Анна', text: 'Да, по витрине у меня готов черновик. Главный вопрос - куда ставить крупные офферы вроде ДеньгиСразу.' },
  { id: 3, timestamp: '00:31', speaker: 'Geo', text: 'По прошлым данным крупный оффер на последней позиции даёт конверсию в разы выше, чем на первой. Это контринтуитивно, но цифры устойчивые.' },
  { id: 4, timestamp: '00:52', speaker: 'Анна', text: 'Тогда предлагаю зафиксировать его именно на последней строке и не трогать в А/Б, чтобы не смазать эффект.' },
  { id: 5, timestamp: '01:10', speaker: 'Geo', text: 'Согласен. Давай так и сделаем. И нужно собрать сводку по конверсии за две недели до пятницы.' },
  { id: 6, timestamp: '01:28', speaker: 'Дмитрий', text: 'Я возьму выгрузку из дашборда. Сверю переходы и выдачи по каждому ключу, если где-то просадка - сразу подсвечу.' },
];

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

export function installDevTauriMock() {
  if (typeof window === 'undefined') return;
  if ((window as any).__TAURI_INTERNALS__) return; // настоящий Tauri - не трогаем
  if (process.env.NODE_ENV !== 'development') return;

  const meetingsApi = DEMO_MEETINGS.map((m) => ({
    id: m.id,
    title: m.title,
    created_at: isoMinutesAgo(m.minutesAgo),
    meeting_type: m.meeting_type,
    duration: m.duration,
    preview: m.preview,
  }));

  const handlers: Record<string, (args?: any) => any> = {
    get_onboarding_status: () => ({ completed: true }),
    insapp_get_identity: () => ({ full_name: 'Geo M', is_registered: true }),
    insapp_get_status: () => ({ settings: { server_url: 'https://meet.insapp.pro' }, connected: true, latency_ms: 28 }),
    api_get_meetings: () => meetingsApi,
    get_audio_devices: () => [
      { name: 'MacBook Pro - микрофон', device_type: 'Input' },
      { name: 'AirPods Pro', device_type: 'Input' },
      { name: 'Внешний USB-микрофон', device_type: 'Input' },
    ],
    get_recording_state: () => {
      const rec = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('dev_screen') === 'recording';
      return { is_recording: rec, is_paused: false, active_duration: rec ? 137 : 0 };
    },
    is_recording: () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('dev_screen') === 'recording',
    is_recording_paused: () => false,
    // Разрешения выданы - чтобы не показывалась карточка «нужен доступ» в dev-вёрстке.
    check_microphone_permission: () => 'authorized',
    check_system_audio_permission: () => 'authorized',
    check_screen_recording_permission: () => 'authorized',
    has_microphone_permission: () => true,
    has_system_audio_permission: () => true,
    api_get_transcript_config: () => ({ provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3', apiKey: null }),
    get_transcription_status: () => ({ chunks_in_queue: 0, is_processing: false, last_activity_ms: 0 }),
    get_meeting: (args) => ({
      id: args?.meetingId || 'demo-1',
      title: 'Встреча 16 июня, 14:30',
      meeting_type: 'internal',
      created_at: isoMinutesAgo(60 * 22),
      transcripts: DEMO_TRANSCRIPT,
    }),
    api_get_transcripts: () => DEMO_TRANSCRIPT,
    get_meeting_transcripts: () => DEMO_TRANSCRIPT,
    api_get_meeting_metadata: (args: any) => {
      const m = DEMO_MEETINGS.find((x) => x.id === args?.meetingId) || DEMO_MEETINGS[0];
      return {
        id: m.id,
        title: m.title,
        created_at: isoMinutesAgo(m.minutesAgo),
        updated_at: isoMinutesAgo(m.minutesAgo - 5),
        folder_path: '/Users/geo/Movies/insapp-recordings/' + m.id,
        meeting_type: m.meeting_type,
        duration: m.duration,
      };
    },
    api_get_meeting_transcripts: () => ({
      transcripts: DEMO_TRANSCRIPT.map((t, i) => ({ ...t, audio_start_time: i * 15, audio_end_time: i * 15 + 12 })),
      has_more: false,
      total_count: DEMO_TRANSCRIPT.length,
    }),
    api_get_summary: () => ({ status: 'idle', summary: null }),
    get_meeting_type: () => 'internal',
    api_get_api_key: () => null,
    get_recording_preferences: () => ({ save_folder: '/Users/geo/Movies/insapp-recordings', auto_save: true, format: 'mp4', mic: null, system: null }),
    list_ignored_apps: () => [],
    parakeet_status: () => ({ ready: true }),
    get_app_version: () => '0.4.0',
  };

  const transparent = async (cmd: string, args?: any): Promise<any> => {
    // События: listen/emit/unlisten - no-op (возвращаем валидные заглушки).
    if (cmd.startsWith('plugin:event|')) {
      if (cmd.endsWith('listen')) return Math.floor(Math.random() * 1e9);
      return null;
    }
    // Updater/process: в dev нет обновления (иначе лезут баннеры «Доступна новая версия»).
    if (cmd.startsWith('plugin:updater|') || cmd.startsWith('plugin:process|')) return null;
    const h = handlers[cmd];
    if (h) {
      try { return h(args); } catch { return null; }
    }
    // catch-all: пустой массив - безопасен для .map/.filter/.length у незамоканных команд
    // (большинство нерасписанных invoke в этом коде ожидают списки).
    return [];
  };

  (window as any).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: any) => transparent(cmd, args),
    transformCallback: (cb: any) => {
      const id = Math.floor(Math.random() * 1e9);
      (window as any)[`_${id}`] = cb;
      return id;
    },
    unregisterCallback: () => {},
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };

  // eslint-disable-next-line no-console
  console.log('[insapp-meet] DEV: установлен мок движка с демо-данными (только браузер).');
}
