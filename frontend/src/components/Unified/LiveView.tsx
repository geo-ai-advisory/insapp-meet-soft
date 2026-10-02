'use client';

/**
 * Идёт запись (эталон b-air/live.html): в центре живая расшифровка мессенджером, справа -
 * «Участники» (имя безымянному голосу прямо во время разговора) и «Кто сколько говорит».
 * Реплики и имена - из тех же источников, что и раньше: TranscriptContext (живые реплики),
 * useSpeakerNames (имена, «голоса коллег» по событию speakers-recognized).
 */

import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Check, Copy, Pencil, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { useSpeakerNames } from '@/hooks/useSpeakerNames';
import { useSummaryReadiness } from '@/hooks/useSummaryJobs';
import { defaultMeetingName, formatKickDate, initialsOf, isAutoMeetingTitle } from '@/lib/meetingFormat';
import { MergedStat, ME_LABEL, MIN_VISIBLE_SHARE, computeSpeakerStats, formatSpeech, isAutoLabel, mergeStatsByLabel, roundShares } from '@/lib/speakerStats';
import { Avatar, Dot, FlatBar, RecDot, Wave, useElementWidth } from './primitives';

export type LiveKind = 'in' | 'out';

interface LiveViewProps {
  startedAt: Date | null;
  elapsed: number;
  paused: boolean;
  meetingType: LiveKind;
  onMeetingTypeChange: (t: LiveKind) => void;
  isProcessingStop: boolean;
  isStopping: boolean;
  /** Кто записывает: «Geo M» и инициалы для «Вы». */
  meName: string;
  meInitials: string;
}

const SPEAKING_MS = 8000;

// Лента не перерисовывается от тиков таймера записи (раз в 0,5 с) - только от новых реплик и имён.
const LiveFeed = memo(VirtualizedTranscriptView);

export function LiveView({
  startedAt, elapsed, paused, meetingType, onMeetingTypeChange, isProcessingStop, isStopping, meName, meInitials,
}: LiveViewProps) {
  const { transcripts, meetingTitle, setMeetingTitle, copyTranscript } = useTranscripts();
  const names = useSpeakerNames(undefined);
  const { readiness, autoSaved } = useSummaryReadiness();
  const titleRef = useRef<HTMLInputElement>(null);
  const nameInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const segments = useMemo(() => transcripts.map((t) => ({
    id: t.id,
    timestamp: t.audio_start_time ?? 0,
    endTime: t.audio_end_time,
    text: t.text,
    confidence: t.confidence,
    // Кто говорит - подпись («Вы» / «Собеседник N») уже во время записи.
    speaker: t.speaker,
  })), [transcripts]);

  const stats = useMemo(() => computeSpeakerStats(transcripts), [transcripts]);
  const now = Date.now();
  const last = transcripts[transcripts.length - 1];
  const lastArrival = last?.id && /^\d{13}-/.test(last.id) ? parseInt(last.id.split('-')[0], 10) : 0;
  const speakingKey = !paused && last?.speaker && lastArrival && now - lastArrival < SPEAKING_MS ? last.speaker : null;

  const title = isAutoMeetingTitle(meetingTitle) ? '' : meetingTitle;
  const placeholder = defaultMeetingName(startedAt ?? new Date());
  const startText = startedAt ? formatKickDate(startedAt).replace(/^(Сегодня|Вчера), /, '$1, начало в ') : '';

  // Участники: «Вы» всегда первым, дальше - в порядке первой реплики. Голоса с одним именем - один
  // человек (слитые вручную: «Это Саша»). Безымянные с долей меньше 3% не показываем - это осколки и шум.
  const merged = useMemo(() => mergeStatsByLabel(stats, names.labelFor), [stats, names.labelFor]);
  const isNamed = (s: MergedStat) => s.keys.some((k) => (!!names.names[k] && !isAutoLabel(names.names[k])) || (k !== 'mic' && !/^system(_\d+)?$/.test(k)));
  const others = merged.filter((s) => s.key !== 'mic').sort((a, b) => a.firstIndex - b.firstIndex);
  const me = merged.find((s) => s.key === 'mic');
  const known = others.filter(isNamed);
  const unknown = others.filter((s) => !isNamed(s) && s.share >= MIN_VISIBLE_SHARE);
  const count = 1 + known.length + unknown.length;
  const speakingIn = (s?: MergedStat) => !!speakingKey && !!s && s.keys.includes(speakingKey);
  // Кому можно отдать реплики безымянного голоса: вы и остальные видимые участники (в разговоре один
  // на один, пока никто не назван, «Собеседник 2» сливается с «Собеседник 1»).
  const mergeTargets = [ME_LABEL, ...[...known, ...unknown].map((k) => names.labelFor(k.key) || '').filter(Boolean)];
  const mergeInto = async (from: MergedStat, label: string) => {
    const was = names.labelFor(from.key) || 'Собеседник';
    for (const k of from.keys) await names.saveName(k, label);
    toast.success(`Реплики «${was}» теперь у «${label}»`, { description: 'В расшифровке, долях речи и резюме - один человек' });
  };

  // «назвать» у реплики: поле имени в «Участниках»; у скрытого осколка (< 3%) поля нет - тогда
  // лента откроет своё окно имени (там же «Это кто-то из участников»).
  const focusName = useCallback((key: string) => {
    const el = nameInputs.current[key];
    if (!el) return false;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.focus();
    return true;
  }, []);

  const autoOn = readiness ? readiness.auto_summary : !!autoSaved;

  return (
    <>
      {/* ------------------------------------------------------------ центр: живая лента */}
      <main className="flex min-h-0 min-w-0 flex-col rounded-[28px] bg-im-sheet pt-5" aria-label="Живая расшифровка">
        <div className="flex flex-none items-center gap-1 pl-7 pr-6">
          <div className="group flex min-w-0 flex-1 items-center gap-1">
            {/* Поле по ширине текста - карандаш стоит сразу за названием, как в макете */}
            <span className="-ml-1.5 inline-grid min-w-0 max-w-full">
              <span aria-hidden="true" className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre border border-transparent px-1.5 py-0.5 text-[24px] font-bold leading-[30px] tracking-[-0.018em]">
                {(title || placeholder) + ' '}
              </span>
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setMeetingTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                placeholder={placeholder}
                aria-label="Название встречи"
                size={1}
                className="col-start-1 row-start-1 w-full min-w-0 truncate rounded-xl border border-transparent bg-transparent px-1.5 py-0.5 text-[24px] font-bold leading-[30px] tracking-[-0.018em] text-im-ink outline-none placeholder:text-im-ink hover:bg-im-tray focus:border-im-acc focus:bg-white focus:placeholder:text-im-mut2"
              />
            </span>
            <button
              type="button"
              onClick={() => { titleRef.current?.focus(); titleRef.current?.select(); }}
              className="grid h-8 w-8 flex-none place-items-center rounded-2xl text-im-mut2 transition-colors hover:bg-im-tray hover:text-im-ink2"
              title="Переименовать"
              aria-label="Переименовать"
            >
              <Pencil className="h-[18px] w-[18px]" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => copyTranscript(names.labelFor)}
            disabled={transcripts.length === 0}
            className="ml-3 inline-flex h-10 flex-none items-center gap-2 rounded-[20px] bg-white pl-3 pr-4 text-[14px] font-semibold text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line2)] transition-[background,border-radius] duration-200 hover:bg-im-hover active:rounded-xl disabled:opacity-50"
          >
            <Copy className="h-5 w-5" />
            Скопировать расшифровку
          </button>
        </div>

        <div className={`flex flex-none flex-wrap items-center gap-3 border-b border-im-line px-7 pb-3.5 pt-2 text-[13px] text-im-mut ${paused ? 'im-paused' : ''}`}>
          <span className="inline-flex items-center gap-1.5 font-semibold text-im-on-tone">
            <RecDot />{paused ? 'На паузе' : 'Идёт запись'}
          </span>
          {startText && <><Dot /><span>{startText}</span></>}
          <div className="inline-flex gap-0.5" role="group" aria-label="Тип встречи">
            {(['in', 'out'] as const).map((k, i) => {
              const on = meetingType === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onMeetingTypeChange(k)}
                  className={`inline-flex h-[30px] items-center gap-1 px-3 text-[12.5px] font-semibold transition-[border-radius,background] duration-300 ${
                    on ? 'rounded-[15px] bg-im-acc text-white' : `bg-im-bg text-im-ink2 hover:bg-im-tray-h ${i === 0 ? 'rounded-[15px_6px_6px_15px]' : 'rounded-[6px_15px_15px_6px]'}`
                  }`}
                >
                  {on && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                  {k === 'in' ? 'Внутренняя' : 'Внешняя'}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <LiveFeed
            segments={segments}
            isRecording
            isPaused={paused}
            isProcessing={isProcessingStop}
            isStopping={isStopping}
            enableStreaming
            showConfidence
            speakerNames={names}
            onNameRequest={focusName}
            contentClassName="px-7 pb-[18px] pt-4"
          />
        </div>

        <div className="flex h-11 flex-none items-center gap-2 border-t border-im-line px-7 text-[12.5px] text-im-mut">
          <Sparkles className="h-4 w-4 flex-none text-im-mut2" />
          {autoOn
            ? 'Резюме появится после встречи · авто-резюме включено'
            : 'Резюме можно сделать после встречи · авто-резюме выключено'}
        </div>
      </main>

      {/* ------------------------------------------------------------ справа: участники */}
      <aside className="flex min-h-0 flex-col rounded-[28px] bg-im-panel px-3 pb-3 pt-[18px]" aria-label="Участники">
        <div className="flex flex-none items-center gap-2 px-2 pb-3">
          <b className="text-[15px] font-bold leading-5 text-im-ink">Участники</b>
          <span className="inline-grid h-5 min-w-[22px] place-items-center rounded-[10px] bg-white px-[7px] text-[12px] font-semibold text-im-mut im-num">{count}</span>
          <span className="flex-1" />
          <span className="text-[12px] text-im-mutbg">узнаём по голосу</span>
        </div>

        <div className="im-scroll min-h-0 flex-1 overflow-y-auto">
          <ul className="flex flex-col gap-0.5">
            {[{ key: 'mic' } as { key: string }, ...known].map((p, i, arr) => {
              const isMe = p.key === 'mic';
              const s = isMe ? me : known.find((o) => o.key === p.key);
              const label = isMe ? 'Вы' : names.labelFor(p.key) || '';
              const speaking = isMe ? speakingIn(me) || speakingKey === 'mic' : speakingIn(s);
              const radius = arr.length === 1 ? 'rounded-[20px]' : i === 0 ? 'rounded-[20px_20px_6px_6px]' : i === arr.length - 1 ? 'rounded-[6px_6px_20px_20px]' : 'rounded-[6px]';
              return (
                <li key={p.key} className={`flex items-center gap-3 bg-white py-[11px] pl-2.5 pr-3 ${radius}`}>
                  <Avatar initials={isMe ? meInitials : initialsOf(label)} me={isMe} size={38} fontSize={12.5} />
                  <div className="min-w-0 flex-1">
                    <b className="block truncate text-[14px] font-semibold leading-[19px] text-im-ink">
                      {label}
                      {isMe && meName && <span className="ml-1.5 text-[12.5px] font-normal text-im-mut">{meName}</span>}
                    </b>
                    {speaking ? (
                      <small className="mt-px flex items-center gap-1.5 text-[12.5px] leading-[17px] text-im-ink2">
                        говорит сейчас
                        <Wave w={24} h={8} p={1} amp={1.6} half={3} sw={1.8} track={false} className="text-im-data" />
                      </small>
                    ) : (
                      <small className="mt-px block truncate text-[12.5px] leading-[17px] text-im-mut">
                        {s?.lastText ? `«${s.lastText}»` : isMe ? 'микрофон включён' : ''}
                      </small>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {unknown.map((s) => (
            <UnknownSpeaker
              key={s.key}
              label={names.labelFor(s.key) || 'Собеседник'}
              lastText={s.lastText}
              speaking={speakingIn(s)}
              targets={mergeTargets.filter((t) => t !== (names.labelFor(s.key) || 'Собеседник'))}
              onMerge={(label) => mergeInto(s, label)}
              inputRef={(el) => { nameInputs.current[s.key] = el; }}
              onSave={async (name) => {
                for (const k of s.keys) await names.saveName(k, name);
                toast.success(`Имя сохранено: ${name}`, { description: 'Подставится во все реплики и в резюме' });
              }}
            />
          ))}
        </div>

        <TalkCard
          stats={[...(me ? [me] : []), ...known, ...unknown]}
          speakingKey={speakingKey}
          elapsed={elapsed}
          labelFor={names.labelFor}
          isUnnamed={(g) => !isNamed(g)}
          meInitials={meInitials}
        />
      </aside>
    </>
  );
}

/** Новый голос без имени: поле «Имя участника» + «Сохранить». */
function UnknownSpeaker({
  label, lastText, speaking, onSave, inputRef, targets, onMerge,
}: {
  label: string;
  lastText: string;
  speaking: boolean;
  onSave: (name: string) => Promise<void>;
  inputRef: (el: HTMLInputElement | null) => void;
  /** Известные участники (и «Вы»): реплики этого голоса можно отдать одному из них. */
  targets: string[];
  onMerge: (label: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <div className="mt-2.5 rounded-[20px] bg-white py-3 pl-2.5 pr-3">
      <div className="flex items-center gap-3">
        <Avatar initials="?" size={38} fontSize={12.5} />
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[14px] font-semibold leading-[19px] text-im-ink">
            {label}<span className="ml-1.5 text-[12.5px] font-normal text-im-mut">ещё без имени</span>
          </b>
          {speaking ? (
            <small className="mt-px flex items-center gap-1.5 text-[12.5px] leading-[17px] text-im-ink2">
              говорит сейчас
              <Wave w={24} h={8} p={1} amp={1.6} half={3} sw={1.8} track={false} className="text-im-data" />
            </small>
          ) : (
            <small className="mt-px block truncate text-[12.5px] leading-[17px] text-im-mut">{lastText ? `«${lastText}»` : ''}</small>
          )}
        </div>
      </div>
      <form
        className="mt-2.5 flex gap-1.5"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = value.trim();
          if (!v) { (e.currentTarget.elements.namedItem('speakerName') as HTMLInputElement | null)?.focus(); return; }
          if (saving) return;
          setSaving(true);
          try { await onSave(v); setValue(''); } finally { setSaving(false); }
        }}
      >
        <input
          ref={inputRef}
          name="speakerName"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Имя участника"
          aria-label={`Имя участника: ${label}`}
          autoComplete="off"
          className="h-9 min-w-0 flex-1 rounded-[18px] border-[1.5px] border-im-line2 bg-white px-3.5 text-[13.5px] text-im-ink outline-none placeholder:text-im-mut focus:border-im-acc"
        />
        <button
          type="submit"
          disabled={saving}
          className="h-9 flex-none rounded-[18px] bg-im-acc px-3.5 text-[13.5px] font-semibold text-white transition-[background,border-radius] duration-200 hover:bg-im-acc-h active:rounded-xl disabled:opacity-60"
        >
          Сохранить
        </button>
      </form>
      {targets.length > 0 ? (
        <div className="mx-1 mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px] leading-4 text-im-mut">
          <span>Или это:</span>
          {targets.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onMerge(t)}
              className="h-7 max-w-[160px] truncate rounded-[14px] bg-im-tone px-2.5 text-[12.5px] font-semibold text-im-on-tone transition-colors hover:bg-im-tone-h"
              title={`Отдать реплики «${label}» участнику «${t}»`}
            >
              {t}
            </button>
          ))}
        </div>
      ) : (
        <p className="mx-1 mt-2 text-[12px] leading-4 text-im-mut">Имя подставится во все реплики и в резюме</p>
      )}
    </div>
  );
}

/** «Кто сколько говорит»: полоска + % + минуты, у говорящего сейчас полоска-волна. */
function TalkCard({
  stats, speakingKey, elapsed, labelFor, isUnnamed, meInitials,
}: {
  stats: MergedStat[];
  speakingKey: string | null;
  elapsed: number;
  labelFor: (sp?: string) => string | undefined;
  isUnnamed: (s: MergedStat) => boolean;
  meInitials: string;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>(276);
  const rows = [...stats].sort((a, b) => b.share - a.share);
  const pct = roundShares(stats);
  const maxShare = rows.reduce((a, s) => Math.max(a, s.share), 0);
  // Длина полоски - доля речи; шкала до 45%, чтобы разница между людьми читалась.
  const scale = Math.max(0.45, maxShare);
  const mins = Math.max(1, Math.round(elapsed / 60));
  return (
    <section className="mt-2.5 flex-none rounded-[22px] bg-white px-4 pb-[18px] pt-4">
      <h3 className="m-0 flex items-center gap-2 text-[14px] font-bold leading-5 text-im-ink">
        Кто сколько говорит
        <span className="ml-auto text-[12px] font-medium text-im-mut">за {mins} мин</span>
      </h3>
      <div ref={ref}>
        {rows.length === 0 && <p className="mt-3 text-[12.5px] text-im-mut">Пока никто не говорил</p>}
        {rows.map((s) => {
          const isMe = s.key === 'mic';
          const label = labelFor(s.key) || '';
          const short = isMe ? 'Вы' : /^Собеседник/.test(label) ? label : label.split(/\s+/)[0];
          const frac = s.share / scale;
          const now = !!speakingKey && s.keys.includes(speakingKey);
          return (
            <div key={s.key} className="mt-4">
              <div className="flex items-center gap-2 text-[13px] leading-[18px] text-im-ink2">
                <Avatar initials={isMe ? meInitials : isUnnamed(s) ? '?' : initialsOf(label)} me={isMe} size={22} fontSize={9} />
                <span className="min-w-0 truncate">{short}</span>
                <span className="ml-auto font-semibold text-im-ink im-num">{pct[s.key] ?? 0}%</span>
                <time className="w-10 text-right text-im-mut im-num">{formatSpeech(s.seconds)}</time>
              </div>
              <div className="mt-[7px] text-im-data">
                {now
                  ? <Wave w={width} h={10} p={frac} amp={1.9} half={3.6} sw={3.2} dot />
                  : <FlatBar w={width} h={6} p={frac} />}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
