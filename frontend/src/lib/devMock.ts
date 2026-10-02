/**
 * DEV-МОК движка (Tauri) для браузерной вёрстки с демо-данными.
 *
 * Только для `npm run dev` в обычном браузере (без Tauri). Подменяет
 * window.__TAURI_INTERNALS__ так, чтобы invoke() возвращал реалистичные демо-данные
 * (встречи, расшифровки, резюме, профиль, устройства, запись), а listen()/event работали.
 * В собранном приложении настоящий __TAURI_INTERNALS__ уже есть -> мок не ставится.
 *
 * Демо-данные совпадают с эталоном дизайна (round3/concepts/b-air): «Синк с продуктом» и т.д.
 *
 * Параметры адреса:
 *   ?dev_screen=recording - запись уже идёт (с репликами из эталона);
 *   ?dev_screen=save      - сразу окно «Сохранить встречу»;
 *   ?dev_empty=1          - встреч нет (пустое состояние);
 *   ?dev_claude=out|ready|nocli|codex - состояние входа в Claude; ?dev_fail=1 - резюме с ошибкой.
 *
 * В консоли браузера:
 *   window.__devEmit(event, payload)          - прислать событие как движок;
 *   window.__devLive.say('system_1', 'Текст') - реплика во время записи ('mic' - Вы);
 *   window.__devLive.script()                 - проиграть разговор из эталона по репликам;
 *   window.__devLive.recognize('system_1', 'Анна Смирнова') - «голоса коллег» узнали собеседника.
 */

type Line = { at: number; sp: string; dur: number; text: string };

// Разговор из эталона: Вы / Анна Смирнова / Дмитрий Орлов / Собеседник 3 (доли речи ~38/34/21/7 %).
const DESIGN_LINES: Line[] = [
  { at: 12, sp: 'mic', dur: 8, text: 'Так, все слышно? Отлично. Сегодня разбираем запуск новой витрины и порядок позиций МФО.' },
  { at: 21, sp: 'system_1', dur: 12, text: 'Да, черновик витрины готов. Главный вопрос - куда ставить крупные офферы вроде ДеньгиСразу.' },
  { at: 33, sp: 'mic', dur: 9, text: 'По прошлым данным крупный оффер на последней позиции даёт конверсию в разы выше, чем на первой.' },
  { at: 45, sp: 'system_1', dur: 11, text: 'Тогда фиксируем его на последней строке и не трогаем в А/Б, чтобы не смазать эффект.' },
  { at: 56, sp: 'system_2', dur: 11, text: 'Я возьму выгрузку из дашборда: переходы и выдачи по каждому ключу.' },
  { at: 64, sp: 'system_2', dur: 10, text: 'Если где-то просадка - сразу подсвечу в чате.' },
  { at: 71, sp: 'mic', dur: 7, text: 'Отлично. Сводка по конверсии за две недели нужна до пятницы.' },
  { at: 80, sp: 'system_1', dur: 11, text: 'Успеем. Раскладку витрины пришлю к среде.' },
  { at: 88, sp: 'mic', dur: 8, text: 'И ещё момент по партнёру: после сводки согласуем с ними дату запуска.' },
  { at: 97, sp: 'system_3', dur: 7, text: 'По партнёру есть вопрос про лимиты - обсудим отдельно?' },
  { at: 104, sp: 'mic', dur: 6, text: 'Да, давай завтра в одиннадцать.' },
];

const GENERIC_LINES: Line[] = [
  { at: 5, sp: 'mic', dur: 9, text: 'Давайте начнём: что изменилось с прошлой недели?' },
  { at: 16, sp: 'system_1', dur: 14, text: 'Цифры по воронке выровнялись, но на втором шаге всё ещё теряем заметную долю пользователей.' },
  { at: 32, sp: 'mic', dur: 10, text: 'Понял. Предлагаю посмотреть, где именно отваливаются, и собрать гипотезы.' },
  { at: 44, sp: 'system_1', dur: 12, text: 'Соберу срез по источникам трафика к четвергу и пришлю в чат.' },
  // Шесть собеседников - проверка карточки «Участники» с «Ещё N» (больше четырёх человек).
  { at: 58, sp: 'system_2', dur: 8, text: 'С моей стороны - обновлю тексты на втором шаге.' },
  { at: 67, sp: 'system_3', dur: 5, text: 'Дизайн поправлю к среде.' },
  { at: 73, sp: 'system_4', dur: 4, text: 'Посмотрю логи ошибок.' },
  // Шум распознавания - в экране встречи не показывается (слова-паразиты).
  { at: 77, sp: 'system_6', dur: 1, text: 'Uh.' },
  { at: 78, sp: 'system_5', dur: 3, text: 'Ок, я на связи.' },
  { at: 82, sp: 'mic', dur: 6, text: 'Отлично, тогда на этом всё.' },
  // Ещё реплики - лента длиннее 10 строк включает виртуальный список (проверка наслоения строк).
  { at: 90, sp: 'system_1', dur: 7, text: 'Подожди, ещё по срокам: срез по источникам успею к четвергу, а гипотезы - к понедельнику.' },
  { at: 98, sp: 'system_2', dur: 5, text: 'Тексты на втором шаге поменяю параллельно.' },
  { at: 104, sp: 'mic', dur: 6, text: 'Договорились. Тогда в понедельник смотрим всё вместе и решаем, что тестируем первым.' },
  { at: 111, sp: 'system_1', dur: 4, text: 'Принято.' },
  { at: 116, sp: 'system_3', dur: 6, text: 'Дизайн второго шага пришлю в среду вечером, чтобы успели посмотреть до встречи.' },
];

const SUMMARY_SINK = [
  '🗓 Синк с продуктом: запуск новой витрины МФО',
  '28.09.2026 · 42 мин · Geo, Анна Смирнова (продукт), Дмитрий Орлов (аналитика)',
  'Разобрали черновик новой витрины и порядок позиций. Договорились зафиксировать крупный оффер внизу и собрать сводку по конверсии.',
  '',
  '## 🎯 Итог',
  '- Крупный оффер - на последнюю позицию. По данным прошлых запусков там конверсия в разы выше, чем на первой строке.',
  '- В А/Б-тесте позицию не трогаем, чтобы не смазать эффект.',
  '- Черновик витрины у Анны готов, правок по структуре нет.',
].join('\n');

const SUMMARY_PARTNER = [
  '🗓 Звонок с партнёром: интеграция витрины',
  '25.09.2026 · 28 мин · Geo (Insapp) · Олег Петров (партнёр)',
  'Партнёр прислал описание методов интеграции - сверили с нашим форматом витрины.',
  '',
  '## 🎯 Итог',
  '- **Интеграция через API партнёра** - их методы подходят, доработка на нашей стороне небольшая.',
  '- Тестовый стенд партнёр откроет до конца недели.',
  '',
  '## ✅ Действия',
  'Insapp:',
  '• Geo: согласовать формат выдачи офферов - до среды',
  '• Дмитрий: подготовить тестовые ключи',
  'Партнёр:',
  '• Олег: открыть тестовый стенд и прислать доступы',
  '',
  '## 📅 Сроки',
  '1. Тестовый стенд - **пятница, 2 октября**.',
  '2. Запуск - после проверки на стенде.',
].join('\n');

function genericSummary(title: string): string {
  return [
    `🗓 ${title}`,
    'Разобрали текущие цифры и договорились о следующих шагах.',
    '',
    '## 🎯 Итог',
    '- Воронка выровнялась, но на втором шаге остаются потери.',
    '- Срез по источникам трафика будет к четвергу.',
  ].join('\n');
}

interface DemoMeeting {
  id: string;
  title: string;
  meeting_type: 'internal' | 'external';
  created: number; // ms
  duration: number; // мин
  preview: string;
  lines: Line[];
  names: Record<string, string>;
  transcript_synced: boolean;
  summary: string | null;
  summary_synced: boolean;
  summary_at: number | null;
  folder: string;
}

function dayAt(daysBack: number, h: number, m: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function buildDemo(): DemoMeeting[] {
  const now = new Date();
  // «Сегодня, 11:30», если утро уже прошло, иначе - час назад.
  const today = now.getHours() * 60 + now.getMinutes() > 12 * 60 + 20 ? dayAt(0, 11, 30) : Date.now() - 60 * 60 * 1000;
  const mk = (id: string, title: string, created: number, duration: number, opts: Partial<DemoMeeting>): DemoMeeting => ({
    id, title, created, duration, meeting_type: 'internal', preview: '', lines: GENERIC_LINES,
    names: { system_1: 'Анна Смирнова' }, transcript_synced: false, summary: null, summary_synced: false,
    summary_at: null, folder: '/Users/geo/Movies/insapp-recordings/' + id, ...opts,
  });
  return [
    mk('demo-1', 'Синк с продуктом', today, 42, {
      lines: DESIGN_LINES, names: { system_1: 'Анна Смирнова', system_2: 'Дмитрий Орлов' },
      transcript_synced: true, summary: SUMMARY_SINK, summary_synced: true, summary_at: today + 44 * 60 * 1000,
      preview: 'Разобрали черновик новой витрины и порядок позиций.',
    }),
    mk('demo-2', 'Разбор воронки МФО', dayAt(1, 16, 5), 65, { preview: 'Прошлись по падению переходов на прошлой неделе.' }),
    mk('demo-3', 'Звонок с партнёром', dayAt(4, 14, 0), 28, {
      meeting_type: 'external', names: { system_1: 'Олег Петров' }, transcript_synced: true,
      summary: SUMMARY_PARTNER, summary_synced: false, summary_at: dayAt(4, 14, 35),
    }),
    mk('demo-4', 'Ретро спринта', dayAt(6, 12, 0), 51, {}),
    mk('demo-5', '1-на-1 с дизайнером', dayAt(10, 15, 0), 33, { summary: genericSummary('1-на-1 с дизайнером'), summary_synced: true, summary_at: dayAt(10, 15, 40) }),
    mk('demo-6', 'Собеседование: продакт-аналитик', dayAt(12, 11, 0), 45, { transcript_synced: true, summary: genericSummary('Собеседование: продакт-аналитик'), summary_synced: true, summary_at: dayAt(12, 11, 50) }),
    mk('demo-7', 'Созвон с банком по интеграции', dayAt(13, 10, 0), 72, { transcript_synced: true, summary: genericSummary('Созвон с банком по интеграции'), summary_synced: true, summary_at: dayAt(13, 11, 15) }),
  ];
}

function linesToTranscripts(id: string, lines: Line[]) {
  return lines.map((l, i) => ({
    id: `${id}-t${i + 1}`,
    text: l.text,
    timestamp: `00:${String(Math.floor(l.at / 60)).padStart(2, '0')}:${String(l.at % 60).padStart(2, '0')}`,
    audio_start_time: l.at,
    audio_end_time: l.at + l.dur,
    duration: l.dur,
    speaker: l.sp,
    confidence: 0.93,
  }));
}

// --- dev: состояние ---
let devAuto = true;
const devJobs: Record<string, number> = {};
let demo: DemoMeeting[] = [];
const savedTranscripts: Record<string, any[]> = {};
const devListeners: { event: string; handler: number; eventId: number }[] = [];
const devRec = { on: false, paused: false, startMs: 0, pauseStartMs: 0, pausedMs: 0, title: '', seq: 0, lastEnd: 0 };
let recCounter = 0;

function qs(name: string): string | null {
  return typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get(name) : null;
}

function devSummaryReadiness() {
  const mode = qs('dev_claude') || 'ready';
  const provider = mode === 'codex' ? 'codex' : 'claude';
  const cli_path = mode === 'nocli' ? null : '/Users/geo/.local/bin/claude';
  const logged_in = provider !== 'claude' || !cli_path ? null : mode === 'out' ? false : true;
  return {
    provider,
    cli_path,
    logged_in,
    claude_ready: provider === 'claude' && !!cli_path && logged_in === true,
    auto_summary: devAuto,
    model: 'sonnet',
  };
}

/** Прислать событие так, как его прислал бы движок (для проверки в браузере). */
function devEmit(event: string, payload: any) {
  devListeners
    .filter((l) => l.event === event)
    .forEach((l) => {
      const cb = (window as any)[`_${l.handler}`];
      if (typeof cb === 'function') cb({ event, id: l.eventId, payload });
    });
}

function recElapsed(): { total: number; active: number } {
  if (!devRec.on) return { total: 0, active: 0 };
  const now = Date.now();
  const total = (now - devRec.startMs) / 1000;
  const pausedNow = devRec.paused ? now - devRec.pauseStartMs : 0;
  return { total, active: Math.max(0, (now - devRec.startMs - devRec.pausedMs - pausedNow) / 1000) };
}

function findMeeting(id?: string): DemoMeeting | undefined {
  return demo.find((m) => m.id === id);
}

function meetingTranscripts(m: DemoMeeting) {
  return savedTranscripts[m.id] || linesToTranscripts(m.id, m.lines);
}

/** Реплика во время записи - как transcript-update от движка. */
function devSay(speaker: string, text: string, dur = 6) {
  if (!devRec.on) {
    console.warn('[dev] запись не идёт - нажмите «Начать запись»');
    return;
  }
  devRec.seq += 1;
  const at = recElapsed().active;
  // Реплики идут одна за другой: начало - не раньше конца предыдущей.
  const start = Math.max(devRec.lastEnd, at - dur, 0);
  devRec.lastEnd = start + dur;
  devEmit('transcript-update', {
    text,
    timestamp: new Date().toTimeString().slice(0, 8),
    source: speaker === 'mic' ? 'mic' : 'system',
    sequence_id: devRec.seq,
    chunk_start_time: start,
    is_partial: false,
    confidence: 0.94,
    audio_start_time: start,
    audio_end_time: start + dur,
    duration: dur,
    speaker,
  });
}

function startJob(id: string, source: 'manual' | 'auto', ms = 6000) {
  const m = findMeeting(id);
  const started_ms = Date.now();
  devJobs[id] = started_ms;
  const ev = (state: string, extra: any = {}) =>
    devEmit('summary-job', { meeting_id: id, title: m?.title || 'Встреча', state, source, started_ms, error: null, auth_error: false, ...extra });
  ev('running');
  const failing = qs('dev_fail') === '1';
  setTimeout(() => {
    delete devJobs[id];
    if (failing) { ev('error', { error: 'Claude вернул пустой ответ' }); return; }
    const mm = findMeeting(id);
    if (mm) {
      mm.summary = id === 'demo-1' ? SUMMARY_SINK : genericSummary(mm.title);
      mm.summary_at = Date.now();
      mm.summary_synced = true;
    }
    ev('done');
    devEmit('ai-summary-saved', id);
  }, ms);
}

export function installDevTauriMock() {
  if (typeof window === 'undefined') return;
  if ((window as any).__TAURI_INTERNALS__) return; // настоящий Tauri - не трогаем
  if (process.env.NODE_ENV !== 'development') return;

  demo = qs('dev_empty') === '1' ? [] : buildDemo();
  // «Ретро спринта» - резюме готовится (статус-волна в списке).
  if (findMeeting('demo-4')) devJobs['demo-4'] = Date.now() - 65 * 1000;
  // ?dev_screen=recording - запись уже идёт, реплики из эталона уже распознаны.
  if (qs('dev_screen') === 'recording') {
    devRec.on = true;
    devRec.startMs = Date.now() - (32 * 60 + 14) * 1000;
    devRec.title = 'Синк с продуктом';
    devRec.seq = DESIGN_LINES.length;
  }

  const handlers: Record<string, (args?: any) => any> = {
    get_onboarding_status: () => ({ completed: true }),
    insapp_get_identity: () => ({ full_name: 'Geo M', is_registered: true }),
    insapp_get_status: () => ({
      settings: { server_url: 'https://meet.insapp.pro', auto_upload: true },
      api_key_preview: 'ab12…cd34', key_source: 'file', queue_size: 0, server_reachable: true,
      full_name: 'Geo M', is_registered: true,
    }),
    api_get_meetings: () => demo.map((m) => ({
      id: m.id,
      title: m.title,
      created_at: new Date(m.created).toISOString(),
      meeting_type: m.meeting_type,
      duration: m.duration,
      preview: m.preview,
      has_transcript: m.lines.length > 0 || !!savedTranscripts[m.id]?.length,
      transcript_synced: m.transcript_synced,
      has_summary: !!m.summary,
      summary_synced: !!m.summary && m.summary_synced,
    })),
    api_get_meeting: (args: any) => {
      const m = findMeeting(args?.meetingId);
      if (!m) throw 'Meeting not found';
      return { id: m.id, title: m.title, meeting_type: m.meeting_type, created_at: new Date(m.created).toISOString(), transcripts: meetingTranscripts(m) };
    },
    api_get_meeting_metadata: (args: any) => {
      const m = findMeeting(args?.meetingId);
      if (!m) throw 'Meeting not found';
      return {
        id: m.id,
        title: m.title,
        created_at: new Date(m.created).toISOString(),
        updated_at: new Date(m.created + 5 * 60000).toISOString(),
        folder_path: m.folder,
        meeting_type: m.meeting_type,
        duration: m.duration,
      };
    },
    api_get_meeting_transcripts: (args: any) => {
      const m = findMeeting(args?.meetingId);
      const all = m ? meetingTranscripts(m) : [];
      const offset = Number(args?.offset || 0);
      const limit = Number(args?.limit || 100);
      const page = all.slice(offset, offset + limit);
      return { transcripts: page, has_more: offset + page.length < all.length, total_count: all.length };
    },
    api_get_transcripts: () => [],
    get_meeting_transcripts: () => [],
    api_get_summary: (args: any) => {
      const m = findMeeting(args?.meetingId);
      if (!m || !m.summary) return { status: 'idle', data: null, meeting_id: args?.meetingId };
      return {
        status: 'completed',
        meeting_id: m.id,
        meeting_name: m.title,
        data: {
          markdown: m.summary,
          format: 'markdown',
          source: 'ai_terminal',
          sync_status: m.summary_synced ? 'sent' : 'pending',
          synced_at: m.summary_at ? new Date(m.summary_at).toISOString() : undefined,
        },
      };
    },
    api_save_meeting_summary: (args: any) => {
      const m = findMeeting(args?.meetingId);
      if (m && args?.summary?.markdown) { m.summary = args.summary.markdown; m.summary_synced = false; }
      return null;
    },
    api_save_meeting_title: (args: any) => { const m = findMeeting(args?.meetingId); if (m) m.title = args.title; return null; },
    api_set_meeting_type: (args: any) => { const m = findMeeting(args?.meetingId); if (m) m.meeting_type = args.meetingType; return null; },
    get_meeting_type: () => 'internal',
    api_delete_meeting: (args: any) => { demo = demo.filter((m) => m.id !== args?.meetingId); return null; },
    api_get_speaker_names: (args: any) => ({ ...(findMeeting(args?.meetingId)?.names || {}) }),
    api_set_speaker_name: (args: any) => {
      const m = findMeeting(args?.meetingId);
      if (m) {
        if (args.displayName) m.names[args.speakerKey] = args.displayName;
        else delete m.names[args.speakerKey];
      }
      return { ok: true };
    },
    api_search_transcripts: (args: any) => {
      const q = String(args?.query || '').toLowerCase();
      if (!q) return [];
      const out: any[] = [];
      for (const m of demo) {
        const hit = meetingTranscripts(m).find((t: any) => t.text.toLowerCase().includes(q));
        if (hit) out.push({ id: m.id, title: m.title, matchContext: hit.text, timestamp: hit.timestamp });
      }
      return out;
    },
    insapp_share_meeting: (args: any) => ({ url: `https://meet.insapp.pro/m/${args?.meetingId}` }),
    insapp_upload_meeting_by_id: (args: any) => { const m = findMeeting(args?.meetingId); if (m) m.transcript_synced = true; return { status: 'sent' }; },
    ai_summary_resend_to_server: (args: any) => { const m = findMeeting(args?.meetingId); if (m) m.summary_synced = true; return { sync_status: 'sent' }; },
    insapp_sync_pending: () => ({ summaries_sent: 0, transcripts_sent: 0 }),
    open_meeting_folder: (args: any) => { console.log('[dev] открыть папку встречи', args?.meetingId); return null; },
    open_external_url: (args: any) => { console.log('[dev] открыть', args?.url); return null; },
    open_system_settings: () => null,

    get_audio_devices: () => [
      { name: 'MacBook Pro - микрофон', device_type: 'Input' },
      { name: 'AirPods Pro', device_type: 'Input' },
      { name: 'Внешний USB-микрофон', device_type: 'Input' },
      { name: 'MacBook Pro - динамики', device_type: 'Output' },
    ],
    attempt_device_reconnect: () => true,

    // --- запись ---
    parakeet_init: () => null,
    parakeet_has_available_models: () => true,
    parakeet_get_available_models: () => [],
    start_recording_with_devices_and_meeting: (args: any) => {
      devRec.on = true;
      devRec.paused = false;
      devRec.startMs = Date.now();
      devRec.pausedMs = 0;
      devRec.seq = 0;
      devRec.lastEnd = 0;
      devRec.title = args?.meeting_name || '';
      setTimeout(() => devEmit('recording-started', null), 60);
      return null;
    },
    start_recording: () => { devRec.on = true; devRec.startMs = Date.now(); setTimeout(() => devEmit('recording-started', null), 60); return null; },
    get_recording_state: () => {
      const e = recElapsed();
      return { is_recording: devRec.on, is_paused: devRec.paused, is_active: devRec.on && !devRec.paused, recording_duration: e.total, active_duration: e.active };
    },
    is_recording: () => devRec.on,
    is_recording_paused: () => devRec.paused,
    pause_recording: () => { if (devRec.on && !devRec.paused) { devRec.paused = true; devRec.pauseStartMs = Date.now(); devEmit('recording-paused', null); } return null; },
    resume_recording: () => { if (devRec.on && devRec.paused) { devRec.pausedMs += Date.now() - devRec.pauseStartMs; devRec.paused = false; devEmit('recording-resumed', null); } return null; },
    stop_recording: () => {
      if (!devRec.on) throw 'No recording in progress';
      devRec.on = false;
      devRec.paused = false;
      setTimeout(() => devEmit('recording-stopped', { message: 'ok', folder_path: '/Users/geo/Movies/insapp-recordings/live', meeting_name: devRec.title }), 30);
      return null;
    },
    get_recording_meeting_name: () => devRec.title || null,
    get_meeting_folder_path: () => '/Users/geo/Movies/insapp-recordings/live',
    get_transcript_history: () => (qs('dev_screen') === 'recording' && devRec.on
      ? DESIGN_LINES.map((l, i) => ({
        id: `live-${i + 1}`, text: l.text, display_time: '', sequence_id: i + 1, confidence: 0.93,
        audio_start_time: l.at, audio_end_time: l.at + l.dur, duration: l.dur, speaker: l.sp,
      }))
      : []),
    get_transcription_status: () => ({ chunks_in_queue: 0, is_processing: false, last_activity_ms: 9000 }),
    api_save_transcript: (args: any) => {
      recCounter += 1;
      const id = `demo-rec-${recCounter}`;
      const transcripts = (args?.transcripts || []).map((t: any, i: number) => ({ ...t, id: `${id}-t${i + 1}` }));
      const end = transcripts.reduce((a: number, t: any) => Math.max(a, t.audio_end_time || 0), 0);
      savedTranscripts[id] = transcripts;
      demo.unshift({
        id, title: args?.meetingTitle || 'Встреча', meeting_type: 'internal', created: Date.now() - end * 1000,
        duration: Math.max(1, Math.round(end / 60)), preview: '', lines: [], names: {},
        transcript_synced: !args?.skipServerUpload, summary: null, summary_synced: false, summary_at: null,
        folder: '/Users/geo/Movies/insapp-recordings/' + id,
      });
      // Авто-резюме после встречи (как движок): резюме пишется в фоне.
      if (devAuto && devSummaryReadiness().claude_ready) setTimeout(() => startJob(id, 'auto', 8000), 400);
      return { meeting_id: id, insapp_sync: args?.skipServerUpload ? 'disabled' : 'sent' };
    },
    send_audio_diagnostic: () => null,

    // Разрешения выданы - чтобы не показывалась карточка «нужен доступ» в dev-вёрстке.
    check_microphone_permission: () => 'authorized',
    check_system_audio_permission: () => 'authorized',
    check_screen_recording_permission: () => 'authorized',
    has_microphone_permission: () => true,
    has_system_audio_permission: () => true,
    api_get_transcript_config: () => ({ provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3', apiKey: null }),
    api_get_model_config: () => ({ provider: 'claude', model: 'sonnet', whisperModel: '', apiKey: null, ollamaEndpoint: null }),
    api_get_api_key: () => null,
    get_recording_preferences: () => ({ save_folder: '/Users/geo/Movies/insapp-recordings', auto_save: true, file_format: 'mp4', format: 'mp4', preferred_mic_device: null, preferred_system_device: null, mic: null, system: null }),
    list_ignored_apps: () => [],
    parakeet_status: () => ({ ready: true }),
    get_app_version: () => '0.4.3',
    trigger_microphone_permission: () => true,
    trigger_system_audio_permission_command: () => true,
    voices_list: () => [
      { name: 'Никита Возаков', meetings: 1, minutes: 3 },
      { name: 'Света Семенова', meetings: 1, minutes: 14 },
      { name: 'Саша Корнеев', meetings: 1, minutes: 7 },
      { name: 'Леонид Зайкин', meetings: 1, minutes: 7 },
    ],
    voices_learn_now: () => 2,
    voices_forget: () => 1,
    get_notification_settings: () => ({ notification_preferences: { show_recording_started: true, show_recording_stopped: true, show_transcription_complete: true } }),

    // Фоновые резюме (dev): состояние входа в Claude - ?dev_claude=out|ready|nocli|codex.
    // ?dev_slow_status=1 - проверка входа в Claude отвечает через 5 с (галочка авто-резюме не должна гаснуть).
    ai_summary_status: () => (qs('dev_slow_status')
      ? new Promise((r) => setTimeout(() => r(devSummaryReadiness()), 5000))
      : devSummaryReadiness()),
    ai_summary_set_auto: (args: any) => { devAuto = !!args?.enabled; return devSummaryReadiness(); },
    ai_summary_get_settings: () => ({ provider: 'claude', command: 'claude', model: 'sonnet', auto_summary: devAuto }),
    // «Удалить запись» в окне сохранения: в браузере файлов нет - просто успех.
    discard_recording: () => null,
    ai_summary_run_batch: () => {
      if (devSummaryReadiness().logged_in === false) throw 'AUTH: Claude не авторизован - войди в свой аккаунт Claude';
      return { started: true };
    },
    ai_summary_batch_status: () => null,
    api_get_meetings_without_summary: () => ({
      items: demo.filter((m) => !m.summary).map((m) => ({ id: m.id, title: m.title, created_at: new Date(m.created).toISOString(), duration: m.duration })),
    }),
    api_skip_summary_for_meetings: () => null,
    ai_summary_jobs: () => Object.entries(devJobs).map(([meeting_id, started_ms]) => ({ meeting_id, started_ms, source: 'manual' })),
    ai_summary_generate: (args: any) => {
      const r = devSummaryReadiness();
      if (r.logged_in === false) throw 'AUTH: Claude не авторизован - войди в свой аккаунт Claude';
      const id = args?.meetingId as string;
      if (devJobs[id]) throw 'Резюме этой встречи уже готовится';
      startJob(id, 'manual');
      return null;
    },
  };

  const transparent = async (cmd: string, args?: any): Promise<any> => {
    // События: listen/emit/unlisten.
    if (cmd.startsWith('plugin:event|')) {
      if (cmd === 'plugin:event|listen') {
        const eventId = Math.floor(Math.random() * 1e9);
        devListeners.push({ event: args?.event, handler: args?.handler, eventId });
        return eventId;
      }
      if (cmd === 'plugin:event|unlisten') {
        const i = devListeners.findIndex((l) => l.eventId === args?.eventId);
        if (i >= 0) devListeners.splice(i, 1);
      }
      if (cmd === 'plugin:event|emit') devEmit(args?.event, args?.payload);
      return null;
    }
    // Updater/process: в dev нет обновления (иначе лезут баннеры «Доступна новая версия»).
    if (cmd.startsWith('plugin:updater|') || cmd.startsWith('plugin:process|')) return null;
    // Файлы (plugin fs) в браузере не пишем - «Скачать .md» там качает файл обычным способом.
    if (cmd.startsWith('plugin:fs|')) throw 'plugin fs недоступен в браузере';
    const h = handlers[cmd];
    if (h) {
      // Ошибки как у движка (reject): резюме, «встреча не найдена», стоп без записи.
      if (cmd.startsWith('ai_summary_') || cmd.startsWith('api_get_meeting') || cmd === 'stop_recording') return h(args);
      try { return h(args); } catch { return null; }
    }
    // catch-all: пустой массив - безопасен для .map/.filter/.length у незамоканных команд
    // (большинство нерасписанных invoke в этом коде ожидают списки).
    return [];
  };

  (window as any).__INMEET_DEV_MOCK__ = true;
  (window as any).__devEmit = devEmit;
  (window as any).__devLive = {
    say: devSay,
    recognize: (speaker: string, name: string) => devEmit('speakers-recognized', { items: [{ speaker, name }] }),
    script: (stepMs = 1400) => {
      DESIGN_LINES.forEach((l, i) => {
        setTimeout(() => devSay(l.sp, l.text, l.dur), i * stepMs);
      });
      // «Голоса коллег»: Анну и Дмитрия узнали по голосу, третий собеседник - новый.
      setTimeout(() => devEmit('speakers-recognized', { items: [{ speaker: 'system_1', name: 'Анна Смирнова' }] }), 2 * stepMs + 300);
      setTimeout(() => devEmit('speakers-recognized', { items: [{ speaker: 'system_2', name: 'Дмитрий Орлов' }] }), 5 * stepMs + 300);
    },
    state: () => ({ ...devRec, ...recElapsed() }),
  };
  // listen() в Tauri 2 при отписке зовёт этот объект - без него в консоли летят ошибки.
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, eventId: number) => {
      const i = devListeners.findIndex((l) => l.eventId === eventId);
      if (i >= 0) devListeners.splice(i, 1);
    },
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

  // ?dev_screen=recording: «голоса коллег» уже узнали Анну и Дмитрия.
  if (qs('dev_screen') === 'recording') {
    setTimeout(() => devEmit('speakers-recognized', { items: [{ speaker: 'system_1', name: 'Анна Смирнова' }, { speaker: 'system_2', name: 'Дмитрий Орлов' }] }), 1200);
  }

  // eslint-disable-next-line no-console
  console.log('[insapp-meet] DEV: установлен мок движка с демо-данными (только браузер). Запись: window.__devLive.say / script / recognize.');
}
