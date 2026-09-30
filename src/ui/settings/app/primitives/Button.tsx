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
import type { ButtonHTMLAttributes, ReactNode } from 'react';

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
  className?: string;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  disabled = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = ['k-btn', VARIANT_CLASS[variant], SIZE_CLASS[size], className]
    .filter((c): c is string => Boolean(c))
    .join(' ');
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy ? true : undefined}
    >
      {children}
    </button>
  );
}