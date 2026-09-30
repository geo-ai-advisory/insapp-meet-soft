'use client';

/**
 * «Участники» прошедшей встречи - карточка под расшифровкой (справа внизу), как «Кто сколько говорит»
 * на экране записи: круг с инициалами, имя, доля речи, минуты и полоска. Безымянному голосу -
 * «назвать» (имя подставится во все реплики и в резюме). Geo 30.09: строка участников под названием
 * занимала много места внутри каждой встречи - перенесли сюда.
 * Больше четырёх человек - остальные под «Ещё N».
 */

import React, { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatSpeech } from '@/lib/speakerStats';
import { Avatar, FlatBar, useElementWidth } from './primitives';

export interface Participant {
  key: string;
  /** Все метки голоса этого человека (голоса, слитые вручную одним именем). */
  keys: string[];
  label: string;
  short: string;
  initials: string;
  me: boolean;
  unnamed: boolean;
  pct: number;
  share: number;
  seconds: number;
}

const LIMIT = 4;

function ParticipantRow({ p, width, scale, onRename, suggestions }: {
  p: Participant;
  width: number;
  scale: number;
  onRename: (name: string) => void;
  /** Имена других участников (и «Вы»): выбрать одно из них - слить реплики с этим человеком. */
  suggestions: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const doneRef = useRef(false);
  const start = () => { doneRef.current = false; setValue(p.unnamed ? '' : p.label); setEditing(true); };
  const finish = (save: boolean) => {
    // Enter и потеря фокуса могут прийти оба - сохраняем один раз.
    if (doneRef.current) return;
    doneRef.current = true;
    const v = value.trim();
    setEditing(false);
    if (save && v && v !== p.label) onRename(v);
  };

  return (
    <li className="mt-3 first:mt-0" title={`${p.label} - доля речи ${p.pct}%`}>
      <div className="flex h-6 items-center gap-2 text-[13px] leading-[18px] text-im-ink2">
        <Avatar initials={p.initials} me={p.me} size={22} fontSize={9} />
        {editing ? (
          <>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); }}
              onBlur={() => finish(true)}
              placeholder="Имя или кто-то из участников"
              aria-label={`Имя участника: ${p.label}`}
              list={`im-people-${p.key}`}
              className="h-6 min-w-0 flex-1 rounded-xl border-[1.5px] border-im-acc bg-white px-2.5 text-[13px] text-im-ink outline-none placeholder:text-im-mut"
            />
            <datalist id={`im-people-${p.key}`}>
              {suggestions.map((n) => <option key={n} value={n} />)}
            </datalist>
          </>
        ) : (
          <>
            {p.me ? (
              <span className="min-w-0 truncate">Вы</span>
            ) : (
              <button
                type="button"
                onClick={start}
                className="min-w-0 truncate rounded-md text-left hover:text-im-on-tone"
                title="Нажмите, чтобы изменить имя"
              >
                {p.label}
              </button>
            )}
            {p.unnamed && (
              <button
                type="button"
                onClick={start}
                className="flex-none rounded-md text-[13px] font-semibold text-im-on-tone hover:underline hover:underline-offset-[3px]"
              >
                назвать
              </button>
            )}
            <span className="ml-auto flex-none font-semibold text-im-ink im-num">{p.pct}%</span>
            <time className="w-10 flex-none text-right text-im-mut im-num">{formatSpeech(p.seconds)}</time>
          </>
        )}
      </div>
      <div className="mt-1 text-im-data">
        <FlatBar w={width} h={4} p={p.share / scale} />
      </div>
    </li>
  );
}

export function ParticipantsCard({ participants, onRename }: {
  participants: Participant[];
  onRename: (keys: string[], name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { ref, width } = useElementWidth<HTMLDivElement>(300);
  if (participants.length === 0) return null;

  // Длина полоски - доля речи; шкала до 45%, чтобы разница между людьми читалась (как на экране записи).
  const maxShare = participants.reduce((a, p) => Math.max(a, p.share), 0);
  const scale = Math.max(0.45, maxShare);
  const hidden = Math.max(0, participants.length - LIMIT);
  const rows = expanded ? participants : participants.slice(0, LIMIT);

  return (
    <section className="flex max-h-[46vh] min-h-0 flex-none flex-col rounded-[24px] bg-im-sheet pb-3.5 pt-3.5" aria-label="Участники">
      <div className="flex flex-none items-center gap-2 px-5 pb-2.5">
        <b className="text-[15px] font-bold leading-5 text-im-ink">Участники</b>
        <span className="inline-grid h-5 min-w-[22px] place-items-center rounded-[10px] bg-im-tray px-[7px] text-[12px] font-semibold text-im-mut im-num">
          {participants.length}
        </span>
        <span className="ml-auto text-[12px] text-im-mut">кто сколько говорил</span>
      </div>
      <div ref={ref} className="im-scroll min-h-0 overflow-y-auto px-5">
        <ul className="m-0 list-none p-0">
          {rows.map((p) => (
            <ParticipantRow
              key={p.key}
              p={p}
              width={width}
              scale={scale}
              onRename={(name) => onRename(p.keys, name)}
              suggestions={participants.filter((o) => o.key !== p.key).map((o) => o.label)}
            />
          ))}
        </ul>
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mx-5 mt-2 inline-flex h-7 flex-none items-center gap-1 self-start rounded-lg text-[13px] font-semibold text-im-on-tone hover:underline hover:underline-offset-[3px]"
          aria-expanded={expanded}
        >
          {expanded ? 'Свернуть' : `Ещё ${hidden}`}
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </section>
  );
}
