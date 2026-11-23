/**
 * The shared button primitive (DESIGN-SYSTEM §11.1, UI-R07).
 *
 * Renders a real `<button>` carrying the shared `.k-btn` classes. The pending
 * state hangs off `aria-busy`, matching `designComponents.webview.css` — a
 * control cannot look busy without announcing it. A busy button is also
 * disabled, which is what stops a duplicate activation (UI-R12) by
 * construction; `aria-busy` is what keeps "loading" distinguishable from a
 * plain "unavailable" button (UI-R17).
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { TablerIcon } from './TablerIcon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'text';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'k-btn--primary',
  secondary: 'k-btn--secondary',
  ghost: 'k-btn--ghost',
  danger: 'k-btn--danger',
  text: 'k-btn--link',
};

const SIZE_CLASS: Readonly<Record<ButtonSize, string | null>> = {
  sm: 'k-btn--sm',
  md: null,
  lg: 'k-btn--lg',
};

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The action is in flight (UI-R11); exposes `aria-busy` and prevents re-activation. */
  busy?: boolean;
  /** Visible spinner (tier 2): pass `useHostMutation().spinning`. Passing it reserves the leading icon slot so width never changes (UI-R18). */
  spinning?: boolean;
  /**
   * A leading Tabler glyph. It IS the spinner slot: while `spinning` the glyph hides and the
   * spinner draws in its place, so the width never changes and no empty slot is reserved (UI-R18).
   */
  icon?: string;
  className?: string;
  children: ReactNode;
  /**
   * The rendered `<button>`, so a caller can move focus to it (e.g. the unsaved
   * bar landing on Save). React 19 passes `ref` as an ordinary prop to a
   * function component, so no `forwardRef` wrapper is needed.
   */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  spinning,
  icon,
  disabled = false,
  className,
  type = 'button',
  children,
  ref,
  ...rest
}: ButtonProps) {
  const classes = ['k-btn', VARIANT_CLASS[variant], SIZE_CLASS[size], icon ? 'k-btn--icon' : spinning === undefined ? null : 'k-btn--slot', spinning ? 'is-spinning' : null, className]
    .filter((c): c is string => Boolean(c))
    .join(' ');
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy ? true : undefined}
    >
      {icon ? (
        <span className="k-btn-icon">
          <TablerIcon name={icon} size={14} />
        </span>
      ) : null}
      {children}
    </button>
  );
}