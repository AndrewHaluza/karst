/**
 * The destructive-action button (UI-R10b, NDL-126 §9.1).
 *
 * R10b asks for destructive controls to be "mapped to danger treatment using an
 * explicit action taxonomy, not a broad keyword regex". `DestructiveButton` is
 * that mapping made checkable by the compiler: its `action` prop is typed to the
 * closed `DestructiveAction` union from `messages.ts`, and `variant` is NOT a
 * prop here at all — the danger class is the only thing this component can
 * render. So a component that deletes an agent, uninstalls an approach or
 * discards a preset row cannot be written with the wrong treatment, and
 * `tsc --noEmit` is the check (R10b's REVIEW component, narrowed to STATIC).
 *
 * The `action` value is also emitted as `data-karst-action`, which is what the
 * Phase 4 parity sweep diffs against the vanilla view's `data-delete-agent` /
 * `data-uninstall` / `data-remove-*` attributes — so a control cannot be
 * re-classified during the port without the sweep noticing.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { DestructiveAction } from '../../messages.js';
import { Button, type ButtonSize } from './Button.js';

export interface DestructiveButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> {
  /** The taxonomy member this control performs. Never free text. */
  action: DestructiveAction;
  /** Danger buttons exist at icon and small-text sizes in the vanilla view. */
  size?: ButtonSize;
  /** The action is in flight (UI-R11/R17); forwarded to the shared primitive. */
  busy?: boolean;
  children: ReactNode;
}

export function DestructiveButton({ action, size, busy, ...rest }: DestructiveButtonProps) {
  return (
    <Button variant="danger" size={size} busy={busy} data-karst-action={action} {...rest} />
  );
}