/**
 * One empty state for every pane (SB-11): a title, an optional hint line and an
 * optional action. The panes used to paint three different shapes; one component
 * keeps the wording, the dim ink and the placement the same under each header.
 */
import type { ReactNode } from 'react';

export interface PaneEmptyProps {
  readonly title: string;
  readonly hint?: ReactNode;
  readonly action?: ReactNode;
  /** The pane's data region (`queue`, `activity`); the ticket list has none. */
  readonly region?: string;
}

export function PaneEmpty({ title, hint, action, region }: PaneEmptyProps) {
  return (
    <div className="pane-empty" data-pane-empty="1" data-region={region}>
      <div className="k-empty-title">{title}</div>
      {hint ? <div className="k-empty-hint">{hint}</div> : null}
      {action ? <div className="k-empty-action">{action}</div> : null}
    </div>
  );
}
