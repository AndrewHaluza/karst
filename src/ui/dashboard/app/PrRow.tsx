/**
 * One pull request row of the dashboard's Pull requests panel: the PR line, the metadata line, the
 * failing-checks disclosure, the CI line, the merge-check line and the comments. Same DOM as the
 * vanilla `renderPrs` helpers it replaced (`mergeLine`, `prMetaLine`, `prComments`, `prChecksDetails`,
 * `ciLine`). Every string is the host's (`prPanelView`, `mergeCheckPanel`, `prChecksView`): this file
 * only places them, and never decides that a PR is mergeable or that a check failed.
 */
import { memo } from 'react';
import type { PrPanelRow } from '../../../model/prPanelView.js';
import { CopyUrl, DismissButton, MergeButton, OpenLink } from './PrActionButtons.js';
import { Icon } from './Icon.js';
import { PrInfo } from './PrInfo.js';
import { PrReadiness } from './PrReadiness.js';
import { Row } from './Row.js';
import type { PrPendingApi } from './usePrPending.js';
import { structurallyEqual } from './useSlice.js';

/** Items with no identity of their own (comments, check names) get a content key made unique by its occurrence count. */
function keyed<T>(items: readonly T[], content: (item: T) => string): Array<readonly [string, T]> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = content(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [`${base}\u0000${n}`, item] as const;
  });
}

/** The lead status icon: shape carries the status, the tone class only adds colour (UI-R28). */
const STATUS_ICON: Readonly<Record<string, { readonly icon: string; readonly tone: string }>> = {
  open: { icon: 'git-pull-request', tone: 'ok' },
  draft: { icon: 'git-pull-request-draft', tone: 'dim' },
  closed: { icon: 'git-pull-request-closed', tone: 'bad' },
  merged: { icon: 'git-merge', tone: 'merged' },
};
const STATUS_ICON_FALLBACK = { icon: 'git-pull-request', tone: 'dim' };

const CHECK_ICON: Readonly<Record<string, string>> = { passing: 'check', failing: 'circle-x', pending: 'loader-2' };

/** The one stamp the line shows: dismissed wins over merged, merged over opened; its full text rides in the title. */
function lineStamp(p: PrPanelRow): { readonly text: string; readonly title: string } | null {
  if (p.dismissedLabel) return { text: p.dismissedLabel, title: p.dismissedLabel };
  if (p.merged) return { text: p.merged, title: p.mergedTitle || p.merged };
  if (p.opened) return { text: p.opened, title: p.openedTitle || p.opened };
  return null;
}

/** The head of `head → base`, or '' when the host knew only one side or none. */
export function prHead(branches: string): string {
  const parts = branches.split(' → ');
  return parts.length === 2 ? parts[0]! : '';
}

function Comments({ p }: { readonly p: PrPanelRow }) {
  if (!p.commentsLabel) return null;
  return (
    <details className="pcms">
      <summary>{p.commentsLabel}</summary>
      {keyed(p.comments, (c) => `${c.author}\u0000${c.when}\u0000${c.body}`).map(([key, c]) => (
        <div className="pcm" key={key}>
          <span className="pcmwho">{c.author || 'unknown'}</span>
          {c.when ? <span className="pcmwhen">{c.when}</span> : null}
          <div className="pcmbody">{c.body}</div>
        </div>
      ))}
    </details>
  );
}

export interface PrRowProps {
  readonly p: PrPanelRow;
  /** The branch the Worktrees header shows once: a PR repeats its branches only when its head differs. */
  readonly headerBranch: string | null;
  readonly mergeBusy: boolean;
  readonly dismissBusy: boolean;
  readonly ciBusy: boolean;
  readonly mergeOpen: boolean;
  readonly infoOpen: boolean;
  readonly onMergeToggle: (repo: string, open: boolean) => void;
  readonly onInfoToggle: (repo: string, open: boolean) => void;
  readonly api: PrPendingApi;
}

export const PrRow = memo(function PrRow({ p, headerBranch, mergeBusy, dismissBusy, ciBusy, mergeOpen, infoOpen, onMergeToggle, onInfoToggle, api }: PrRowProps) {
  const repoLabel = p.repoDisplay || p.repo;
  // Suppressed on a merged PR: it landed, and a stale rollup beside `merged` would state a question that is closed.
  const live = p.status !== 'merged';
  const status = STATUS_ICON[p.status] ?? STATUS_ICON_FALLBACK;
  const stamp = lineStamp(p);
  const head = prHead(p.branches);
  const showBranches = p.branches !== '' && (head === '' || head !== headerBranch);
  const blocking = live && !p.dismissed ? p.readiness.reasons.filter((r) => r.state !== 'ok').length : 0;
  const sub = (
    <>
      <PrReadiness p={p} ciBusy={ciBusy} mergeOpen={mergeOpen} onMergeToggle={onMergeToggle} />
      <Comments p={p} />
    </>
  );
  return (
    <div className={`prrow${p.dismissed ? ' dismissed' : ''}`}>
      <Row
        className="pr"
        lead={
          <span className={`pr-lead ${status.tone}`} data-status={p.status || 'unknown'}>
            <Icon name={status.icon} size={14} />
          </span>
        }
        trail={
          <span className="pacts">
            <DismissButton p={p} api={api} busy={dismissBusy} />
            <MergeButton p={p} busy={mergeBusy} />
          </span>
        }
        sub={sub}
      >
        {/* The manifest NAME when one resolves; the path (the row's identity) rides in the tooltip. */}
        <span className="prepo" title={repoLabel !== p.repo ? p.repo : undefined}>
          {repoLabel}
        </span>
        <span className="pnum">
          {p.url ? (
            <OpenLink url={p.url} title="Open this pull request">
              {p.number != null ? `#${p.number}` : ''}
            </OpenLink>
          ) : p.number != null ? (
            `#${p.number}`
          ) : null}
        </span>
        {p.url ? <CopyUrl url={p.url} /> : null}
        <PrInfo p={p} open={infoOpen} onToggle={onInfoToggle} />
        <span className={`k-chip pst pst-${p.status || 'unknown'}`}>{p.status || ''}</span>
        {live && p.checks && p.checks.label ? (
          <span className={`k-chip pck pck-${p.checks.state}`} title={p.checks.title}>
            <Icon name={CHECK_ICON[p.checks.state] ?? 'check'} size={11} />
            {p.checks.label}
          </span>
        ) : null}
        {blocking > 0 ? (
          <span className="k-chip pblock" title={p.mergeBlockedReason}>
            {`blocked · ${blocking} ${blocking === 1 ? 'reason' : 'reasons'}`}
          </span>
        ) : null}
        {stamp ? (
          <span className="pstamp" title={stamp.title}>
            {stamp.text}
          </span>
        ) : null}
        {showBranches ? (
          <span className="pbranch" title={p.branches}>
            {p.branches}
          </span>
        ) : null}
      </Row>
    </div>
  );
}, (a, b) =>
  a.api === b.api &&
  a.onMergeToggle === b.onMergeToggle &&
  a.onInfoToggle === b.onInfoToggle &&
  a.headerBranch === b.headerBranch &&
  a.mergeBusy === b.mergeBusy &&
  a.dismissBusy === b.dismissBusy &&
  a.ciBusy === b.ciBusy &&
  a.mergeOpen === b.mergeOpen &&
  a.infoOpen === b.infoOpen &&
  structurallyEqual(a.p, b.p));
