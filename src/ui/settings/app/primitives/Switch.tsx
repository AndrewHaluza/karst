/**
 * The switch primitive (UI-R08: controls have one owner).
 *
 * The vanilla roster marks state with `role="switch"` buttons carrying the shared
 * `.k-switch` / `.k-switch-track` pair — a boolean control that reads as a toggle
 * rather than a checkbox. Porting one meant writing that markup outside
 * `primitives/`, which `architecture.test.ts` fails on purpose: the DS class and
 * the ARIA pairing are exactly the things that must not be re-declared per tab.
 *
 * Two deliberate choices:
 *
 * - **`role="switch"` with `aria-checked`, not a checkbox.** The vanilla view
 *   already exposes these as switches; a checkbox would be a semantics change on
 *   a live control.
 * - **The label rides `aria-label`/`title` from the caller**, because the roster
 *   card has no visible label for the toggle — it has a hint ("Install to
 *   enable") that explains why the control is dead. Passing the hint here is how
 *   a disabled switch explains itself.
 */
import type { ReactNode } from 'react';

export interface SwitchProps {
  readonly checked: boolean;
  /** Accessible name and hover hint — the vanilla "Enable in create flow" copy. */
  readonly label: string;
  /** A switch with no usable target is disabled, never hidden. */
  readonly disabled?: boolean;
  /** Emitted verbatim so phase 4's parity sweep can diff the control. */
  readonly name?: string;
  readonly onChange: (next: boolean) => void;
  readonly children?: ReactNode;
}

export function Switch({ checked, label, disabled = false, name, onChange, children }: SwitchProps) {
  return (
    <button
      type="button"
      className="k-switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-switch={name}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="k-switch-track" />
      {children}
    </button>
  );
}
