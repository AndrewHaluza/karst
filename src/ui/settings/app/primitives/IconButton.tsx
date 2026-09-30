/**
 * The shared icon-button primitive (DESIGN-SYSTEM §11.2, UI-R24 / UI-R21).
 *
 * The accessible name is a REQUIRED prop and is used verbatim as both
 * `aria-label` and `title`, so the two descriptions cannot disagree (UI-R21).
 * The glyph is wrapped in an `aria-hidden` element because the button itself is
 * already named (UI-R24) — a missing `label` is a `tsc` error, not a review
 * catch.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'children' | 'className' | 'aria-label' | 'title'
  > {
  /** Required accessible name; rendered as both `aria-label` and `title`. */
  label: string;
  /** Destructive icon action (UI-R10b). */
  danger?: boolean;
  /** The action is in flight (UI-R11); exposes `aria-busy`. */
  busy?: boolean;
  className?: string;
  /** The decorative glyph. */
  children: ReactNode;
}

export function IconButton({
  label,
  danger = false,
  busy = false,
  disabled = false,
  className,
  type = 'button',
  children,
  ...rest
}: IconButtonProps) {
  const classes = ['k-iconbtn', danger ? 'k-iconbtn--danger' : null, className]
    .filter((c): c is string => Boolean(c))
    .join(' ');
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      aria-busy={busy ? true : undefined}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}