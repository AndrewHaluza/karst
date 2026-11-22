/**
 * The workflow-status marker (DESIGN-SYSTEM §11.12, UI-R28 / UI-R28b).
 *
 * A non-interactive, icon-only marker: the state is carried by a distinct
 * glyph/shape, never by hue alone (UI-R28), and the primitive renders no visible
 * status word (UI-R28b). `kind` is a closed union, so a caller cannot invent a
 * state; the mapping is the single owner for every React view.
 *
 * It lives in `shared/` because more than one view paints it: the sidebar
 * (rows, Planning, peek), Settings, and the views that adopt it next (D753,
 * D754) read this one renderer and the `.k-status` CSS in
 * `model/designComponents.webview.css`. Keep the union and the class names
 * stable.
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
  /**
   * The accessible name in the caller's domain wording (UI-R28b): a sidebar row
   * passes the shared `GLYPH_WORD` word, Planning passes its own status word.
   * Falls back to the kind's own wording when the caller has no better name.
   */
  label?: string;
  /** UI-R28b: the primitive never renders a visible status word. */
  children?: never;
}

export function Status({ kind, label }: StatusProps): ReactNode {
  const spec = STATUS[kind];
  return (
    <span className={`k-status k-status--${kind}`} role="img" aria-label={label ?? spec.label}>
      {spec.marker ?? <span className="k-spinner" aria-hidden="true" />}
    </span>
  );
}
