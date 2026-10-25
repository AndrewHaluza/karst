/**
 * Renders a panel into its container in `webview.html`: the static shell keeps the region roots the parity snapshots
 * pin (`.dhead`, `.svpanel`, `#subtaskPanel`, ...), and each region draws into its own root. The container is looked up
 * once. A missing container is a wiring fault, so it throws.
 */
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function RegionPortal({
  id,
  byClass,
  children,
  inParent = false,
  into,
}: {
  /** The container's id; omit it (and pass `byClass`) for a static root the parity snapshots pin without an id. */
  readonly id?: string;
  /** The container's first element with this class, for a root that has no id. */
  readonly byClass?: string;
  readonly children: ReactNode;
  /** Render into `#id`'s parent instead (appended after its children): for a control that has no container of its own. */
  readonly inParent?: boolean;
  /** Render into this descendant of `#id` (a CSS selector scoped to it): for a control in a static header that has no id of its own. */
  readonly into?: string;
}) {
  const [target] = useState(() => {
    const found = id === undefined ? (document.getElementsByClassName(byClass ?? '')[0] ?? null) : document.getElementById(id);
    if (into) return found?.querySelector(into) ?? null;
    return inParent ? (found?.parentElement ?? null) : found;
  });
  if (!target) {
    throw new Error(`dashboard app: ${id === undefined ? `.${byClass}` : `#${id}`} region container is missing from the document`);
  }
  return createPortal(children, target);
}
