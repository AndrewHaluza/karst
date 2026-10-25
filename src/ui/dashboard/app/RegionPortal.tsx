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
  children,
  inParent = false,
  into,
}: {
  readonly id: string;
  readonly children: ReactNode;
  /** Render into `#id`'s parent instead (appended after its children): for a control that has no container of its own. */
  readonly inParent?: boolean;
  /** Render into this descendant of `#id` (a CSS selector scoped to it): for a control in a static header that has no id of its own. */
  readonly into?: string;
}) {
  const [target] = useState(() => {
    const found = document.getElementById(id);
    if (into) return found?.querySelector(into) ?? null;
    return inParent ? (found?.parentElement ?? null) : found;
  });
  if (!target) {
    throw new Error(`dashboard app: #${id} region container is missing from the document`);
  }
  return createPortal(children, target);
}
