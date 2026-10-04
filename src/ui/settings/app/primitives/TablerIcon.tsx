/**
 * A Tabler glyph as an opaque island (R-X6): the shared `karstIconInto` from
 * the DS runtime (`/*KARST_DS_JS*\/`) fills a span React never reconciles
 * children into, so the app holds no SVG markup and no raw-HTML escape hatch.
 */
import { useEffect, useRef } from 'react';

export type IconMount = (element: HTMLElement, name: string, size?: number) => void;

export function TablerIcon({
  name,
  size = 14,
  mount,
}: {
  readonly name: string;
  readonly size?: number;
  /** Injected in tests; defaults to the page-global `karstIconInto`. */
  readonly mount?: IconMount | null;
}) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const fill = mount ?? ((globalThis as { karstIconInto?: IconMount }).karstIconInto ?? null);
    if (!root || !fill) return;
    fill(root, name, size);
  }, [mount, name, size]);
  return <span ref={rootRef} className="icon-island" aria-hidden="true" />;
}
