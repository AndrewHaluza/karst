/**
 * The one panel pattern of the dashboard's Servers, Worktrees and Pull requests (ui:LAYOUT-PRIMITIVES):
 * a header row (title, count, one-line summary, right-aligned actions) over a body. The three panels
 * render it into their `.panel` roots; the body keeps the id the panel's tests and parity cases key on.
 */
import type { ReactNode } from 'react';

export interface SectionProps {
  readonly title: string;
  /** Shown only when truthy and not zero-length: an empty panel has no count. */
  readonly count?: number | string | null;
  /** One dim line; it truncates and the full text rides in `title` (UI-R44). */
  readonly summary?: ReactNode;
  /** The summary as plain text, for its `title`. */
  readonly summaryTitle?: string;
  /** Render the summary in the mono face (a branch name). */
  readonly summaryMono?: boolean;
  readonly actions?: ReactNode;
  readonly bodyId?: string;
  readonly children?: ReactNode;
}

export function Section({ title, count, summary, summaryTitle, summaryMono, actions, bodyId, children }: SectionProps) {
  const hasCount = count !== null && count !== undefined && count !== '' && count !== 0;
  const hasSummary = summary !== null && summary !== undefined && summary !== '' && summary !== false;
  return (
    <>
      <div className="phead">
        <span className="sec-title">{title}</span>
        {hasCount ? <span className="count">{String(count)}</span> : null}
        {hasSummary ? (
          <span className={summaryMono ? 'sec-sum mono' : 'sec-sum'} title={summaryTitle} aria-label={summaryTitle}>
            {summary}
          </span>
        ) : null}
        {actions ? <span className="pops">{actions}</span> : null}
      </div>
      <div className="pbody" id={bodyId}>
        {children}
      </div>
    </>
  );
}

/** A group's caption inside a body: small uppercase label, count, note. */
export function GroupHeader({ label, count, note }: { readonly label: string; readonly count: number; readonly note?: string }) {
  return (
    <div className="sec-group" role="presentation">
      <span className="gname">{label}</span>
      <span className="gcount">{count}</span>
      {note ? <span className="gnote">{note}</span> : null}
    </div>
  );
}
