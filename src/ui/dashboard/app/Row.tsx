/**
 * The Row of the Section pattern: a grid of `lead | main | trail` with an optional sub-line spanning
 * main and trail. The trail's actions rest dim until the row is hovered or holds focus.
 */
import type { ReactNode } from 'react';

export interface RowProps {
  readonly lead?: ReactNode;
  readonly children: ReactNode;
  readonly trail?: ReactNode;
  readonly sub?: ReactNode;
  /** Extra state classes (`dim`, `fault`), joined onto the row. */
  readonly className?: string;
  readonly 'data-row'?: string;
}

export function Row({ lead, children, trail, sub, className, 'data-row': dataRow }: RowProps) {
  return (
    <div className={className ? `krow ${className}` : 'krow'} data-row={dataRow}>
      <span className="krow-lead">{lead}</span>
      <div className="krow-main">{children}</div>
      {trail ? <span className="krow-trail">{trail}</span> : <span className="krow-trail" />}
      {sub ? <div className="krow-sub">{sub}</div> : null}
    </div>
  );
}
