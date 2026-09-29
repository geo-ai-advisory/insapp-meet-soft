'use client';

/**
 * Мелкие элементы главного экрана INmeet (эталон b-air): волнистый прогресс, полоска,
 * круглые аватары с инициалами, точка записи, «уровни» звука, разделитель «·».
 */

import React, { useEffect, useId, useRef, useState } from 'react';

/** Волнистый прогресс (M3 Expressive): волна до p*w, потом ровный трек и точка-стоп. run - волна «течёт». */
export function Wave({
  w, h = 10, p = 1, amp = 2, half = 4, sw = 2.4, track = true, run = true, dot = true, className = '',
}: {
  w: number; h?: number; p?: number; amp?: number; half?: number; sw?: number;
  track?: boolean; run?: boolean; dot?: boolean; className?: string;
}) {
  const rid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const cid = `imw${rid}`;
  const y = h / 2;
  const pp = Math.max(0, Math.min(1, p));
  const xe = Math.max(sw, pp * w);
  const start = -4 * half;
  const n = Math.floor((xe - start) / half) + 6;
  const d = `M${start.toFixed(1)} ${y.toFixed(1)} q${(half / 2).toFixed(2)} ${(-amp * 2).toFixed(2)} ${half.toFixed(2)} 0` + ` t${half.toFixed(2)} 0`.repeat(n);
  const gap = 4;
  const x1 = xe + gap;
  const x2 = w - (sw / 2 + (dot ? 4 : 0));
  return (
    <svg className={`block overflow-visible ${className}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <defs>
        <clipPath id={cid}><rect x="0" y="0" width={xe.toFixed(1)} height={h} rx={(sw / 2).toFixed(1)} /></clipPath>
      </defs>
      <g clipPath={`url(#${cid})`}>
        <path
          className={run ? 'im-wave-run' : undefined}
          style={{ ['--hw' as any]: `${(2 * half).toFixed(2)}px` }}
          d={d} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round"
        />
      </g>
      {track && pp < 1 && x2 > x1 && (
        <path d={`M${x1.toFixed(1)} ${y.toFixed(1)}H${x2.toFixed(1)}`} stroke="var(--im-data-t)" fill="none" strokeWidth={sw} strokeLinecap="round" />
      )}
      {track && pp < 1 && dot && (
        <circle cx={(w - sw / 2 - 0.2).toFixed(1)} cy={y.toFixed(1)} r={(sw / 2 + 0.1).toFixed(2)} fill="currentColor" />
      )}
    </svg>
  );
}

/** Ровная полоска доли речи. */
export function FlatBar({ w, h = 6, p = 0.5, className = '' }: { w: number; h?: number; p?: number; className?: string }) {
  const pp = Math.max(0, Math.min(1, p));
  return (
    <svg className={`block ${className}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <rect x="0" y="0" width={w} height={h} rx={h / 2} fill="var(--im-data-t)" />
      <rect x="0" y="0" width={Math.max(h, pp * w).toFixed(1)} height={h} rx={h / 2} fill="currentColor" />
    </svg>
  );
}

/** Ширина элемента (для полосок и волн на всю ширину карточки). */
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width || 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/**
 * Круглый аватар с инициалами. «Вы» - синий круг с белыми буквами,
 * остальные - светло-голубой круг с синими, неизвестный голос - «?».
 */
export function Avatar({
  initials, me = false, size = 22, fontSize, className = '', title,
}: { initials: string; me?: boolean; size?: number; fontSize?: number; className?: string; title?: string }) {
  const fs = fontSize ?? Math.max(8, Math.round(size * 0.4));
  return (
    <i
      title={title}
      aria-hidden={title ? undefined : true}
      className={`grid flex-none place-items-center rounded-full not-italic font-bold leading-none tracking-[0.02em] ${
        me ? 'bg-im-acc text-white' : 'bg-im-tone text-im-on-tone'
      } ${className}`}
      style={{ width: size, height: size, fontSize: fs }}
    >
      {initials}
    </i>
  );
}

/** Красная пульсирующая точка записи. */
export function RecDot({ className = '' }: { className?: string }) {
  return <i className={`im-rdot block h-2 w-2 flex-none rounded-full bg-im-rec ${className}`} aria-hidden="true" />;
}

/** «Уровень» звука - три пляшущие полоски. */
export function Lvl({ className = '' }: { className?: string }) {
  return (
    <span className={`im-lvl ml-px inline-flex h-[11px] items-center gap-[1.5px] ${className}`} aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

/** Разделитель «·». */
export function Dot() {
  return <span className="text-im-dotm" aria-hidden="true">·</span>;
}
