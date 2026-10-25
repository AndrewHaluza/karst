/**
 * One pull request row of the dashboard's Pull requests panel: the PR line, the metadata line, the
 * failing-checks disclosure, the CI line, the merge-check line and the comments. Same DOM as the
 * vanilla `renderPrs` helpers it replaced (`mergeLine`, `prMetaLine`, `prComments`, `prChecksDetails`,
 * `ciLine`). Every string is the host's (`prPanelView`, `mergeCheckPanel`, `prChecksView`): this file
 * only places them, and never decides that a PR is mergeable or that a check failed.
 */
import { memo, type ReactNode } from 'react';
import type { MergeCheckPanelRow } from '../../../model/mergeCheckPanel.js';
import type { PrPanelRow } from '../../../model/prPanelView.js';
import { CiButton, CopyUrl, DismissButton, MergeButton, OpenLink, ResolveButton } from './PrActionButtons.js';
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

type Failing = PrPanelRow['checks']['failing'][number];

/** A failing check: a link through the same `open-pr` act when the run has a URL, else its plain name. */
function CheckRows({ failing }: { readonly failing: readonly Failing[] }) {
  return (
    <>
      {keyed(failing, (c) => `${c.name}\u0000${c.url ?? ''}`).map(([key, c]) => (
        <div className="pck-row" key={key}>
          {c.url ? (
            <OpenLink url={c.url} title="Open this check run">
              {c.name}
            </OpenLink>
          ) : (
            <span>{c.name}</span>
          )}
        </div>
      ))}
    </>
  );
}

function Dot({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mg">
      <span className="mgdot" aria-hidden="true" />
      {children}
    </div>
  );
}

/** Branch (truncates; the full value rides in title) and the stamps (one group, so they wrap intact). */
function Meta({ p }: { readonly p: PrPanelRow }) {
  const stamps: ReactNode[] = [];
  if (p.opened) {
    stamps.push(
      <span className="psep" key="so">
        ·
      </span>,
      <span className="pstamp" key="o" title={p.openedTitle || undefined}>
        {p.opened}
      </span>,
    );
  }
  if (p.merged) {
    stamps.push(
      <span className="psep" key="sm">
        ·
      </span>,
      <span className="pstamp pmerged" key="m" title={p.mergedTitle || undefined}>
        {p.merged}
      </span>,
    );
  }
  if (!p.branches && stamps.length === 0) return null;
  return (
    <div className="pmeta">
      {p.branches ? (
        <span className="pbranch" title={p.branches}>
          {p.branches}
        </span>
      ) : null}
      {stamps.length > 0 ? <span className="pstamps">{stamps}</span> : null}
    </div>
  );
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

function ChecksDetails({ p }: { readonly p: PrPanelRow }) {
  // Suppressed on a merged PR: it landed, and a stale rollup beside `merged` would state a closed question.
  if (p.status === 'merged' || !p.checks || !p.checks.detailsLabel) return null;
  return (
    <details className="pcks">
      <summary>{p.checks.detailsLabel}</summary>
      <CheckRows failing={p.checks.failing} />
    </details>
  );
}

/** Pending reads "CI running"; failing names the failures, with the host's availability deciding the button; anything else renders nothing. */
function CiLine({ p, offer, busy, api }: { readonly p: PrPanelRow; readonly offer: boolean; readonly busy: boolean; readonly api: PrPendingApi }) {
  if (!p.checks || p.status === 'merged') return null;
  if (p.checks.state === 'pending') {
    return (
      <div className="mgwrap mg-ci">
        <Dot>
          <span className="mgtext">CI running</span>
        </Dot>
      </div>
    );
  }
  if (p.checks.state !== 'failing') return null;
  const n = p.checks.failing.length;
  return (
    <div className="mgwrap mg-ci mg-ci-failing">
      <Dot>
        <span className="mgtext">{`CI failing — ${n} ${n === 1 ? 'check' : 'checks'}`}</span>
        {offer ? <CiButton api={api} busy={busy} /> : null}
      </Dot>
      <CheckRows failing={p.checks.failing} />
    </div>
  );
}

interface MergeLineProps {
  readonly m: MergeCheckPanelRow;
  readonly open: boolean;
  readonly onToggle: (repo: string, open: boolean) => void;
}

/** A repo with no check renders nothing: never asked is not the same as clean. */
function MergeLine({ m, open, onToggle }: MergeLineProps) {
  const body = m.reason ? (
    <div className="mgreason">{m.reason}</div>
  ) : (
    keyed(m.files, (f) => f).map(([key, f]) => (
      <div className="mgfile" key={key}>
        {f}
      </div>
    ))
  );
  return (
    <div className={`mgwrap mg-${m.state}`}>
      <Dot>
        {/* The host's stamp already starts with "checked": the doubled word is the vanilla title, pinned by the parity snapshot. */}
        <span className="mgtext" title={m.checkedTitle ? `checked ${m.checkedTitle}` : undefined}>
          {m.headline}
        </span>
        {m.state === 'conflicted' ? <ResolveButton repo={m.repo} /> : null}
      </Dot>
      {m.detailsLabel ? (
        // Controlled: the user's open/closed choice outlives the line itself (the vanilla `openMergeRepos`).
        <details className="mgd" data-repo={m.repo} open={open} onToggle={(e) => onToggle(m.repo, e.currentTarget.open)}>
          <summary>{m.detailsLabel}</summary>
          <div className="mgdbody">{body}</div>
        </details>
      ) : null}
    </div>
  );
}

export interface PrRowProps {
  readonly p: PrPanelRow;
  readonly m: MergeCheckPanelRow | undefined;
  /** The host lists this repo as one whose failing CI can be sent to the agent. */
  readonly ciOffer: boolean;
  readonly mergeBusy: boolean;
  readonly dismissBusy: boolean;
  readonly ciBusy: boolean;
  readonly mergeOpen: boolean;
  readonly onMergeToggle: (repo: string, open: boolean) => void;
  readonly api: PrPendingApi;
}

export const PrRow = memo(function PrRow({ p, m, ciOffer, mergeBusy, dismissBusy, ciBusy, mergeOpen, onMergeToggle, api }: PrRowProps) {
  const repoLabel = p.repoDisplay || p.repo;
  // Suppressed on a merged PR: it landed, and a stale rollup beside `merged` would state a question that is closed.
  const live = p.status !== 'merged';
  return (
    <div className="prrow">
      <div className="pr">
        <span className={`k-chip pst pst-${p.status || 'unknown'}`}>{p.status || ''}</span>
        {live && p.checks && p.checks.label ? (
          <span className={`k-chip pck pck-${p.checks.state}`} title={p.checks.title}>
            {p.checks.label}
          </span>
        ) : null}
        {live && p.mergeBlockLabel ? (
          <span className="k-chip pblock" title={p.mergeBlockedReason}>
            {p.mergeBlockLabel}
          </span>
        ) : null}
        {/* The manifest NAME when one resolves; the path (the row's identity) rides in the tooltip. */}
        <span className="prepo" title={repoLabel !== p.repo ? p.repo : undefined}>
          {repoLabel}
        </span>
        {p.url ? <CopyUrl url={p.url} /> : null}
        <span className="pnum">
          {p.url ? (
            <OpenLink url={p.url} title="Open this pull request">
              {p.number != null ? `#${p.number}` : ''}
            </OpenLink>
          ) : p.number != null ? (
            `#${p.number}`
          ) : null}
        </span>
        <span className="pacts">
          {p.dismissedLabel ? <span className="pstamp">{p.dismissedLabel}</span> : null}
          <DismissButton p={p} api={api} busy={dismissBusy} />
          <MergeButton p={p} api={api} busy={mergeBusy} />
        </span>
      </div>
      <Meta p={p} />
      <ChecksDetails p={p} />
      <CiLine p={p} offer={ciOffer} busy={ciBusy} api={api} />
      {m ? <MergeLine m={m} open={mergeOpen} onToggle={onMergeToggle} /> : null}
      <Comments p={p} />
    </div>
  );
}, (a, b) =>
  a.api === b.api &&
  a.onMergeToggle === b.onMergeToggle &&
  a.ciOffer === b.ciOffer &&
  a.mergeBusy === b.mergeBusy &&
  a.dismissBusy === b.dismissBusy &&
  a.ciBusy === b.ciBusy &&
  a.mergeOpen === b.mergeOpen &&
  structurallyEqual(a.p, b.p) &&
  structurallyEqual(a.m, b.m));
