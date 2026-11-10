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
import { Icon } from './Icon.js';
import { PrInfo } from './PrInfo.js';
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

/** Failing names the failures, with the host's availability deciding the button; anything else renders nothing (the checks chip already says pending). */
function CiLine({ p, offer, busy }: { readonly p: PrPanelRow; readonly offer: boolean; readonly busy: boolean }) {
  if (!p.checks || p.status === 'merged') return null;
  if (p.checks.state !== 'failing') return null;
  const n = p.checks.failing.length;
  return (
    <div className="mgwrap mg-ci mg-ci-failing">
      <Dot>
        <span className="mgtext">{`CI failing — ${n} ${n === 1 ? 'check' : 'checks'}`}</span>
        {offer ? <CiButton busy={busy} /> : null}
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
  /** The branch the Worktrees header shows once: a PR repeats its branches only when its head differs. */
  readonly headerBranch: string | null;
  /** The host lists this repo as one whose failing CI can be sent to the agent. */
  readonly ciOffer: boolean;
  readonly mergeBusy: boolean;
  readonly dismissBusy: boolean;
  readonly ciBusy: boolean;
  readonly mergeOpen: boolean;
  readonly infoOpen: boolean;
  readonly onMergeToggle: (repo: string, open: boolean) => void;
  readonly onInfoToggle: (repo: string, open: boolean) => void;
  readonly api: PrPendingApi;
}

export const PrRow = memo(function PrRow({ p, m, headerBranch, ciOffer, mergeBusy, dismissBusy, ciBusy, mergeOpen, infoOpen, onMergeToggle, onInfoToggle, api }: PrRowProps) {
  const repoLabel = p.repoDisplay || p.repo;
  // Suppressed on a merged PR: it landed, and a stale rollup beside `merged` would state a question that is closed.
  const live = p.status !== 'merged';
  const status = STATUS_ICON[p.status] ?? STATUS_ICON_FALLBACK;
  const stamp = lineStamp(p);
  const head = prHead(p.branches);
  const showBranches = p.branches !== '' && (head === '' || head !== headerBranch);
  const whyBlocked = live && !p.canMerge && !p.dismissed ? p.mergeBlockedReason : '';
  const sub = (
    <>
      {whyBlocked ? <div className="pwhy">{whyBlocked}</div> : null}
      <ChecksDetails p={p} />
      <CiLine p={p} offer={ciOffer} busy={ciBusy} />
      {m ? <MergeLine m={m} open={mergeOpen} onToggle={onMergeToggle} /> : null}
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
        {live && p.mergeBlockLabel ? (
          <span className="k-chip pblock" title={p.mergeBlockedReason}>
            {p.mergeBlockLabel}
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
  a.ciOffer === b.ciOffer &&
  a.mergeBusy === b.mergeBusy &&
  a.dismissBusy === b.dismissBusy &&
  a.ciBusy === b.ciBusy &&
  a.mergeOpen === b.mergeOpen &&
  a.infoOpen === b.infoOpen &&
  structurallyEqual(a.p, b.p) &&
  structurallyEqual(a.m, b.m));
