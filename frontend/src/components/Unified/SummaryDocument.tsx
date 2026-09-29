'use client';

/**
 * Резюме встречи как документ (эталон b-air, .doc): заголовок с эмодзи, строка «дата · участники»,
 * абзац, карточка «Итог» и остальные разделы протокола (Действия, Сроки, ...).
 * Источник - markdown резюме (как его пишет Claude по промпту протокола); вид - только отображение,
 * правка идёт в редакторе резюме (BlockNoteSummaryView) по кнопке «Править».
 */

import React, { useMemo } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { stripTitleH1 } from '@/lib/meetingFormat';

interface Section {
  title: string;
  emoji: string;
  body: string;
  isItog: boolean;
}

interface ParsedSummary {
  title: string;
  meta: string;
  lead: string;
  sections: Section[];
}

// Эмодзи в начале строки (с вариантами и составными) - для значка раздела.
const EMOJI_RE = new RegExp('^((?:\\p{Extended_Pictographic}|\\p{Regional_Indicator})(?:\\uFE0F|\\u200D(?:\\p{Extended_Pictographic})\\uFE0F?)*)\\s*(.*)$', 'u');

function splitEmoji(s: string): { emoji: string; text: string } {
  const m = EMOJI_RE.exec(s.trim());
  if (m && m[2]) return { emoji: m[1], text: m[2] };
  return { emoji: '', text: s.trim() };
}

function unbold(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\*\*|\*\*$/g, '').trim();
}

/**
 * Протокол Claude -> ровный markdown: «• пункт» -> пункт списка; строка-подзаголовок после списка
 * («Партнёр:» после пунктов «Insapp:») - отдельным абзацем, а не продолжением последнего пункта.
 */
function normalizeBullets(md: string): string {
  const lines = md.replace(/^(\s*)•\s+/gm, '$1- ').split('\n');
  const isItem = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const out: string[] = [];
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    if (i > 0 && l.trim() && !/^\s/.test(l) && !isItem(l) && !/^#{1,6}\s/.test(l) && prev !== undefined && isItem(prev)) out.push('');
    out.push(l);
  });
  return out.join('\n');
}

/**
 * Для редактора: строки шапки протокола («🗓 О чём», «дата · участники», «что смотрели») идут
 * без пустых строк - в markdown это один абзац, и после правки они склеились бы в одну строку.
 * Разносим их пустыми строками, чтобы редактор держал их отдельными абзацами.
 */
export function separateHeaderLines(markdown: string): string {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => /^#{1,6}\s+/.test(l));
  const head = first === -1 ? lines : lines.slice(0, first);
  const tail = first === -1 ? [] : lines.slice(first);
  // Пункт списка / цитата / код / таблица (у маркера списка после него обязателен пробел: «28.09.2026» - не список).
  const isBlock = (l: string) => /^\s*([-*+•]\s|\d+[.)]\s|>|```|\|)/.test(l);
  const out: string[] = [];
  head.forEach((l, i) => {
    out.push(l);
    const next = head[i + 1];
    if (next !== undefined && l.trim() && next.trim() && !isBlock(l) && !isBlock(next)) out.push('');
  });
  return [...out, ...tail].join('\n');
}

export function parseSummary(markdown: string): ParsedSummary {
  const text = normalizeBullets(stripTitleH1(markdown || '').replace(/\r\n/g, '\n')).trim();
  const lines = text.split('\n');
  const isHeading = (l: string) => /^#{1,3}\s+/.test(l);
  const firstHeading = lines.findIndex(isHeading);

  const headerLines = (firstHeading === -1 ? lines : lines.slice(0, firstHeading));
  const rest = firstHeading === -1 ? [] : lines.slice(firstHeading);

  let title = '';
  let meta = '';
  let lead = '';
  if (firstHeading === -1) {
    // Резюме без разделов - показываем как есть, но первую строку с эмодзи делаем заголовком.
    const nonEmpty = headerLines.findIndex((l) => l.trim());
    const first = nonEmpty >= 0 ? headerLines[nonEmpty].trim() : '';
    if (first && first.length <= 160 && (splitEmoji(first).emoji || /^\*\*.+\*\*$/.test(first))) {
      title = unbold(first);
      lead = headerLines.slice(nonEmpty + 1).join('\n').trim();
    } else {
      lead = text;
    }
  } else {
    const nonEmpty = headerLines.map((l, i) => ({ l: l.trim(), i })).filter((x) => x.l);
    if (nonEmpty.length > 0 && nonEmpty[0].l.length <= 160) {
      title = unbold(nonEmpty[0].l);
      let from = nonEmpty[0].i + 1;
      const second = nonEmpty[1];
      if (second && second.l.length <= 220 && (/·/.test(second.l) || /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(second.l))) {
        meta = unbold(second.l);
        from = second.i + 1;
      }
      lead = headerLines.slice(from).join('\n').trim();
    } else {
      lead = headerLines.join('\n').trim();
    }
  }

  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const line of rest) {
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) {
      if (cur) sections.push(cur);
      const { emoji, text: t } = splitEmoji(unbold(h[1]));
      cur = { title: t, emoji, body: '', isItog: /итог/i.test(t) };
    } else if (cur) {
      cur.body += `${line}\n`;
    }
  }
  if (cur) sections.push(cur);
  sections.forEach((s) => { s.body = s.body.trim(); });
  return { title, meta, lead, sections };
}

function openLink(href?: string) {
  if (!href) return;
  invoke('open_external_url', { url: href }).catch(() => {
    try { window.open(href, '_blank', 'noopener'); } catch { /* нет браузера */ }
  });
}

const mdComponents: Components = {
  p: ({ children }) => <p className="m-0 [&+*]:mt-2.5">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-im-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => { e.preventDefault(); openLink(href); }}
      className="font-medium text-im-on-tone underline decoration-im-line2 underline-offset-[3px] hover:decoration-im-on-tone"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="im-ul m-0 flex list-none flex-col gap-2.5 p-0 [&+*]:mt-2.5 [li_&]:mt-2 [li_&]:gap-1.5">{children}</ul>,
  ol: ({ children }) => <ol className="im-ol m-0 flex list-none flex-col gap-2.5 p-0 [&+*]:mt-2.5 [li_&]:mt-2 [li_&]:gap-1.5">{children}</ol>,
  li: ({ children }) => (
    <li className="flex gap-3">
      <i className="im-bullet im-sh-cookie9 mt-[7px] block h-[11px] w-[11px] flex-none bg-im-bullet" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  ),
  h1: ({ children }) => <h4 className="m-0 mt-3 text-[16px] font-bold leading-6 text-im-ink">{children}</h4>,
  h2: ({ children }) => <h4 className="m-0 mt-3 text-[16px] font-bold leading-6 text-im-ink">{children}</h4>,
  h3: ({ children }) => <h4 className="m-0 mt-3 text-[15.5px] font-bold leading-6 text-im-ink">{children}</h4>,
  h4: ({ children }) => <h4 className="m-0 mt-3 text-[15.5px] font-bold leading-6 text-im-ink">{children}</h4>,
  h5: ({ children }) => <h5 className="m-0 mt-3 text-[15px] font-semibold leading-6 text-im-ink">{children}</h5>,
  h6: ({ children }) => <h6 className="m-0 mt-3 text-[15px] font-semibold leading-6 text-im-ink">{children}</h6>,
  blockquote: ({ children }) => <blockquote className="m-0 border-l-2 border-im-line2 pl-3 text-im-mut">{children}</blockquote>,
  code: ({ children }) => <code className="rounded-md bg-im-tray px-1 py-px text-[0.92em]">{children}</code>,
  hr: () => <hr className="my-4 border-0 border-t border-im-line" />,
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-[14px]">{children}</table></div>,
  th: ({ children }) => <th className="border-b border-im-line2 px-2 py-1.5 text-left font-semibold text-im-ink">{children}</th>,
  td: ({ children }) => <td className="border-b border-im-line px-2 py-1.5 align-top">{children}</td>,
};

function Md({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{children}</ReactMarkdown>;
}

export function SummaryDocument({
  markdown, headerAction, byline,
}: {
  markdown: string;
  /** «Править» справа от заголовка резюме. */
  headerAction?: React.ReactNode;
  /** Подпись внизу: «Резюме написал Claude Sonnet в 12:14». */
  byline?: React.ReactNode;
}) {
  const doc = useMemo(() => parseSummary(markdown), [markdown]);

  return (
    <article className="im-doc">
      <div className="flex items-start gap-4">
        {doc.title ? (
          <h2 className="im-balance m-0 min-w-0 flex-1 text-[21px] font-bold leading-7 tracking-[-0.012em] text-im-ink">{doc.title}</h2>
        ) : <span className="flex-1" />}
        {headerAction}
      </div>
      {doc.meta && <p className="m-0 mt-1.5 text-[13px] leading-[19px] text-im-mut">{doc.meta}</p>}
      {doc.lead && (
        <div className={`${doc.title ? 'mt-3.5' : ''} text-[16px] leading-[26px] text-im-ink2`}>
          <Md>{doc.lead}</Md>
        </div>
      )}
      {doc.sections.map((s, i) => (
        <section
          key={`${s.title}-${i}`}
          className={`mt-[22px] text-[15.5px] leading-6 text-im-ink2 ${s.isItog ? 'rounded-[20px] bg-im-bg px-5 pb-[18px] pt-4' : ''}`}
        >
          <h3 className="m-0 mb-2.5 flex items-center gap-2.5 text-[17px] font-bold leading-[22px] text-im-ink">
            {s.emoji && (
              <i className="im-sh-cookie12 grid h-[34px] w-[34px] flex-none place-items-center bg-im-butter text-[17px] not-italic" aria-hidden="true">
                {s.emoji}
              </i>
            )}
            <span className="min-w-0">{s.title}</span>
          </h3>
          {s.body && <Md>{s.body}</Md>}
        </section>
      ))}
      {byline}
    </article>
  );
}
