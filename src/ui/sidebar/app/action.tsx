/**
 * Posting controls. Every control that posts to the host carries its identity as
 * `data-*` attributes (`data-act` / `data-open` plus the id it targets) and goes
 * through ONE firing path: the design-system runtime's pending primitives
 * (`karstRequestId` + `karstBeginPending`, the pieces `karstAction` uses
 * internally) so each gets the same four properties — pending on click,
 * non-re-triggerable, terminal result via `action-result`, and the watchdog
 * (UI-R11–R14).
 */
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useSidebar } from './SidebarContext.js';

/** What a posting control targets. `act` names the message; `open` is the open-ticket shorthand. */
export interface ActionSpec {
  readonly act?: string;
  readonly id?: number;
  readonly open?: number;
  readonly plan?: number;
  readonly proposal?: number;
  readonly repo?: string;
}

/** The `data-*` attribute set a spec stamps on its control (test and styling hooks, and the menu's source). */
export function specAttrs(spec: ActionSpec): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (spec.act !== undefined) out['data-act'] = spec.act;
  if (spec.id !== undefined) out['data-id'] = spec.id;
  if (spec.open !== undefined) out['data-open'] = spec.open;
  if (spec.plan !== undefined) out['data-plan'] = spec.plan;
  if (spec.proposal !== undefined) out['data-proposal'] = spec.proposal;
  if (spec.repo !== undefined) out['data-repo'] = spec.repo;
  return out;
}

type NativeProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type' | 'children'>;

export interface ActButtonProps extends NativeProps {
  readonly spec: ActionSpec;
  readonly children?: ReactNode;
  /** Runs before the request posts (e.g. closing the context window the control lives in). */
  readonly beforeFire?: () => void;
}

export function ActButton({ spec, beforeFire, children, ...rest }: ActButtonProps) {
  const { fire } = useSidebar();
  return (
    <button
      type="button"
      {...rest}
      {...specAttrs(spec)}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        beforeFire?.();
        fire(spec, e.currentTarget, e);
      }}
    >
      {children}
    </button>
  );
}
