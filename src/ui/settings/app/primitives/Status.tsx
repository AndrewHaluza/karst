/**
 * The workflow-status marker (DESIGN-SYSTEM §11.12, UI-R28 / UI-R28b).
 *
 * A non-interactive, icon-only marker: the state is carried by a distinct
 * glyph/shape, never by hue alone (UI-R28), and the primitive renders no visible
 * status word (UI-R28b). `kind` is a closed union, so a caller cannot invent a
 * state; the mapping is the single owner for the React view.
 *
 * `.k-status` itself is the open v3.0 gap G1 (`docs/ui/V3-CONFORMANCE-GAPS.md`):
 * the class is the documented target and its CSS lands with that gap. Until the
 * React app is wired into the shipped chain (phase 4) nothing renders it.
 */
import type { ReactNode } from 'react';

export type StatusKind =
  | 'pending'
  | 'running'
  | 'attention'
  | 'passed'
  | 'failed'
  | 'bypassed';

interface StatusSpec {
  /** The distinct visible glyph; `null` means the spinner element is used. */
  readonly marker: string | null;
  /** The accessible name, in domain wording (UI-R28b). */
  readonly label: string;
}

const STATUS: Readonly<Record<StatusKind, StatusSpec>> = {
  pending: { marker: '○', label: 'Pending' },
  running: { marker: null, label: 'Running' },
  attention: { marker: '⏸', label: 'Needs attention' },
  passed: { marker: '✓', label: 'Passed' },
  failed: { marker: '✕', label: 'Failed' },
  bypassed: { marker: '⊘', label: 'Bypassed' },
};

export interface StatusProps {
  kind: StatusKind;
  /** UI-R28b: the primitive never renders a visible status word. */
  children?: never;
}

export function Status({ kind }: StatusProps): ReactNode {
  const spec = STATUS[kind];
  return (
    <span className={`k-status k-status--${kind}`} role="img" aria-label={spec.label}>
      {spec.marker ?? <span className="k-spinner" aria-hidden="true" />}
    </span>
  );
}