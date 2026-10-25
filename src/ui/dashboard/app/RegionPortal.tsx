/**
 * Renders a migrated panel into its EXISTING container in `webview.html` (strangler,
 * `ui:DASHBOARD-MIGRATION`). The app stays mounted at `#root`; the container is looked
 * up once, by id, and carries `data-react-owned` in the page so the vanilla document
 * delegators skip it. A missing container is a wiring fault, so it throws.
 */
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function RegionPortal({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  const [target] = useState(() => document.getElementById(id));
  if (!target) {
    throw new Error(`dashboard app: #${id} region container is missing from the document`);
  }
  return createPortal(children, target);
}
