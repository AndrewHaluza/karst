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
  region,
  children,
  inParent = false,
  into,
}: {
  /** The container's id; omit it (and pass `byClass`) for a static root the parity snapshots pin without an id. */
  readonly id?: string;
  /** The container's first element with this class, for a root that has no id. */
  readonly byClass?: string;
  /**
   * The `data-region` value of a `.panel` root that must stay bare: the layout ledger keys that root's
   * findings by its structural path, which an id or a second class would rename.
   */
  readonly region?: string;
  readonly children: ReactNode;
  /** Render into `#id`'s parent instead (appended after its children): for a control that has no container of its own. */
  readonly inParent?: boolean;
  /** Render into this descendant of `#id` (a CSS selector scoped to it): for a control in a static header that has no id of its own. */
  readonly into?: string;
}) {
  const [target] = useState(() => {
    const found =
      id !== undefined
        ? document.getElementById(id)
        : region !== undefined
          ? (Array.from(document.getElementsByClassName('panel')).find((e) => (e as HTMLElement).dataset.region === region) ?? null)
          : (document.getElementsByClassName(byClass ?? '')[0] ?? null);
    if (into) return found?.querySelector(into) ?? null;
    return inParent ? (found?.parentElement ?? null) : found;
  });
  if (!target) {
    const what = id !== undefined ? `#${id}` : region !== undefined ? `[data-region="${region}"]` : `.${byClass}`;
    throw new Error(`dashboard app: ${what} region container is missing from the document`);
  }
  return createPortal(children, target);
}
