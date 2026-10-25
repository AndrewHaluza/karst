/**
 * Renders a migrated panel into its EXISTING container in `webview.html` (strangler,
 * `ui:DASHBOARD-MIGRATION`). The app stays mounted at `#root`; the container is looked
 * up once, by id, and carries `data-react-owned` in the page so the vanilla document
 * delegators skip it. A missing container is a wiring fault, so it throws.
 */
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function RegionPortal({
  id,
  byClass,
  children,
  inParent = false,
}: {
  /** The container's id; omit it (and pass `byClass`) for a static root the parity snapshots pin without an id. */
  readonly id?: string;
  /** The container's first element with this class, for a root that has no id. */
  readonly byClass?: string;
  readonly children: ReactNode;
  /** Render into `#id`'s parent instead (appended after its children): for a control that has no container of its own. */
  readonly inParent?: boolean;
}) {
  const [target] = useState(() => {
    const found = id === undefined ? (document.getElementsByClassName(byClass ?? '')[0] ?? null) : document.getElementById(id);
    return inParent ? (found?.parentElement ?? null) : found;
  });
  if (!target) {
    throw new Error(`dashboard app: ${id === undefined ? `.${byClass}` : `#${id}`} region container is missing from the document`);
  }
  return createPortal(children, target);
}
