'use client';

import type { LucideIcon } from 'lucide-react';

/**
 * Рубильник значками: два положения, белый бегунок со значком выбранного, второй значок бледный на дорожке.
 * Шапка экрана записи (Geo 06.10: «нужен рубильник ... просто значками», «внутренняя и внешняя тоже иконками»):
 * «компьютер / облако» - куда уйдёт встреча, «офис / рукопожатие» - внутренняя или внешняя. Смысл словами - в подсказке.
 */
export function IconSwitch({
  right,
  onToggle,
  Left,
  Right,
  label,
  title,
  tintRight = false,
  leftActive = 'text-im-acc',
  disabled = false,
}: {
  /** Бегунок справа (второе положение). */
  right: boolean;
  onToggle: () => void;
  Left: LucideIcon;
  Right: LucideIcon;
  /** Что выбрано сейчас - для экранного диктора. */
  label: string;
  /** Подсказка при наведении: что значит положение и что будет при переключении. */
  title: string;
  /** Голубая дорожка, когда бегунок справа (облако - «включено»). */
  tintRight?: boolean;
  /** Цвет значка на бегунке слева. */
  leftActive?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={right}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-[30px] w-[62px] flex-none rounded-[15px] transition-colors duration-200 disabled:cursor-default disabled:opacity-60 ${
        tintRight && right ? 'bg-im-tone hover:bg-im-tone-h' : 'bg-im-bg hover:bg-im-tray-h'
      }`}
    >
      <Left className="absolute left-[9px] top-[8px] h-3.5 w-3.5 text-im-mut2" strokeWidth={2.2} aria-hidden="true" />
      <Right className="absolute right-[9px] top-[8px] h-3.5 w-3.5 text-im-mut2" strokeWidth={2.2} aria-hidden="true" />
      <span
        aria-hidden="true"
        className={`absolute left-[3px] top-[3px] grid h-6 w-[26px] place-items-center rounded-full bg-white shadow-[0_1px_3px_rgba(16,24,40,.18)] transition-transform duration-200 ${
          right ? 'translate-x-[30px]' : 'translate-x-0'
        }`}
      >
        {right
          ? <Right className="h-3.5 w-3.5 text-im-acc" strokeWidth={2.4} />
          : <Left className={`h-3.5 w-3.5 ${leftActive}`} strokeWidth={2.4} />}
      </span>
    </button>
  );
}
