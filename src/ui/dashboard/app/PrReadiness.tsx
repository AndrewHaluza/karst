/**
 * The merge-readiness block of one pull request: ready is one green line, blocked is a bordered list with one
 * row per reason. Two or more blocking reasons fold into one closed `details` whose summary carries the brief
 * items and the actions; one reason keeps the plain list (a collapsed check or file list inside). It replaces the separate CI line, failing-checks details and merge-check line. Every string
 * and every verdict is the host's (`model/prMergeReadiness.ts`); this file only places them and never decides
 * that a PR is mergeable. An action is rendered only when the host attached it to the reason.
 */
import { memo } from 'react';
import { isBlocking } from '../../../model/prMergeReadiness.js';
import type { Reason, ReasonAction, ReasonListItem } from '../../../model/prMergeReadiness.js';
import type { PrPanelRow } from '../../../model/prPanelView.js';
import { CiButton, OpenButton, OpenLink, ResolveButton, SingleFlightButton } from './PrActionButtons.js';
import { Icon } from './Icon.js';

const STATE_ICON: Readonly<Record<Reason['state'], string>> = {
  bad: 'circle-x',
  warn: 'alert-triangle',
  run: 'loader-2',
  ok: 'circle-check',
  note: 'info-circle',
};

/** Items with no identity of their own get a content key made unique by its occurrence count. */
function keyed<T>(items: readonly T[], content: (item: T) => string): Array<readonly [string, T]> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = content(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [`${base}\u0000${n}`, item] as const;
  });
}

function Items({ list }: { readonly list: readonly ReasonListItem[] }) {
  return (
    <>
      {keyed(list, (i) => `${i.text}\u0000${i.url ?? ''}`).map(([key, i]) => (
        <div className="pck-row" key={key}>
          {i.url ? (
            <OpenLink url={i.url} title="Open this check run">
              {i.text}
            </OpenLink>
          ) : (
            <span>{i.text}</span>
          )}
        </div>
      ))}
    </>
  );
}

function ActionButton({ action, repo, ciBusy }: { readonly action: ReasonAction; readonly repo: string; readonly ciBusy: boolean }) {
  switch (action.act) {
    case 'open-pr':
      return action.url ? <OpenButton url={action.url} label={action.label} /> : null;
    case 'send-ci-failure':
      return <CiButton busy={ciBusy} label={action.label} />;
    case 'resolve-conflicts':
      return <ResolveButton repo={action.repo ?? repo} label={action.label} />;
    case 'rebase-on-base':
      return <SingleFlightButton name="rebase" act="rebase-on-base" label={action.label} title="Rebase onto the base branch, regenerate files, push with a lease" />;
    case 'address-pr-feedback':
      return <SingleFlightButton name="prFeedback" act="address-pr-feedback" label={action.label} title="Address the review team's pull request feedback — UAT and Review will run again" />;
  }
}

interface ReasonRowProps {
  readonly r: Reason;
  /** True inside the folded body: a blocking reason's action rides on the summary line (a note has none there), and the list is already open. */
  readonly folded?: boolean;
  readonly repo: string;
  readonly ciBusy: boolean;
  readonly open: boolean;
  readonly onToggle: (repo: string, open: boolean) => void;
}

function ReasonRow({ r, folded = false, repo, ciBusy, open, onToggle }: ReasonRowProps) {
  const hasBody = (r.list?.length ?? 0) > 0 || r.why !== undefined;
  // The first disclosure of a conflicts reason is the one the panel remembers (the vanilla `openMergeRepos`).
  const remembered = r.kind === 'conflicts';
  return (
    <li className={`prsn prsn-${r.state}`} data-kind={r.kind}>
      <div className="prsn-line">
        <span className="prsn-icon" aria-hidden="true">
          <Icon name={STATE_ICON[r.state]} size={13} />
        </span>
        <span className="prsn-text">
          <b className="prsn-label">{r.label}</b>
          {r.detail ? <span className="prsn-detail">{r.detail}</span> : null}
        </span>
        {r.action && (!folded || r.state === 'note') ? <ActionButton action={r.action} repo={repo} ciBusy={ciBusy} /> : null}
      </div>
      {r.extra ? <div className="prsn-extra">{r.extra}</div> : null}
      {hasBody && folded ? (
        <div className="mgdbody prsn-more">
          {r.why !== undefined ? <div className="mgreason">{r.why}</div> : null}
          {r.list ? <Items list={r.list} /> : null}
          {r.listNote ? <div className="prsn-note">{r.listNote}</div> : null}
        </div>
      ) : hasBody ? (
        <details
          className="mgd prsn-more"
          data-repo={repo}
          {...(remembered ? { open, onToggle: (e: React.SyntheticEvent<HTMLDetailsElement>) => onToggle(repo, e.currentTarget.open) } : {})}
        >
          <summary>{r.disclosure ?? (r.list ? `${r.list.length} ${r.list.length === 1 ? 'item' : 'items'}` : '')}</summary>
          <div className="mgdbody">
            {r.why !== undefined ? <div className="mgreason">{r.why}</div> : null}
            {r.list ? <Items list={r.list} /> : null}
            {r.listNote ? <div className="prsn-note">{r.listNote}</div> : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

/** The summary line of the folded list: chevron, headline, one brief item per blocking reason, then the actions. */
function FoldSummary({ headline, blockers, repo, ciBusy }: { readonly headline: string; readonly blockers: readonly Reason[]; readonly repo: string; readonly ciBusy: boolean }) {
  const acting = blockers.filter((r) => r.action !== undefined);
  return (
    <summary className="prblock-head">
      <span className="prblock-chev" aria-hidden="true">
        <Icon name="chevron-right" size={13} />
      </span>
      <b>{headline}</b>
      <span className="prblock-items">
        {blockers.map((r) => (
          <span className={`prblock-item prsn-${r.state}`} data-kind={r.kind} key={r.kind}>
            <span className="prsn-icon" aria-hidden="true">
              <Icon name={STATE_ICON[r.state]} size={12} />
            </span>
            {r.short}
          </span>
        ))}
      </span>
      {acting.length > 0 ? (
        // A click on an action must not toggle the disclosure: cancel the summary's default, the button's own handler already ran.
        <span className="prblock-acts" onClick={(e) => e.preventDefault()}>
          {acting.map((r) => (
            <ActionButton key={r.kind} action={r.action!} repo={repo} ciBusy={ciBusy} />
          ))}
        </span>
      ) : null}
    </summary>
  );
}

interface PrReadinessProps {
  readonly p: PrPanelRow;
  readonly ciBusy: boolean;
  readonly mergeOpen: boolean;
  readonly onMergeToggle: (repo: string, open: boolean) => void;
}

/** Nothing for a merged PR (it landed), a dismissed one, or one with no reason to state. */
export const PrReadiness = memo(function PrReadiness({ p, ciBusy, mergeOpen, onMergeToggle }: PrReadinessProps) {
  const { readiness } = p;
  if (p.status === 'merged' || p.dismissed) return null;
  const notes = (
    <ul className="prblock-list prblock-notes">
      {readiness.reasons.map((r) => (
        <ReasonRow key={r.kind} r={r} repo={p.repo} ciBusy={ciBusy} open={mergeOpen} onToggle={onMergeToggle} />
      ))}
    </ul>
  );
  if (readiness.ready) {
    return (
      <>
        <div className="prready" data-state="ready">
          <span className="prready-icon" aria-hidden="true">
            <Icon name="circle-check" size={13} />
          </span>
          <b>{readiness.headline}</b>
          <span className="prready-facts">{readiness.facts}</span>
        </div>
        {readiness.reasons.length > 0 ? notes : null}
      </>
    );
  }
  if (readiness.reasons.length === 0) return null;
  const blockers = readiness.reasons.filter(isBlocking);
  const n = blockers.length;
  // Notes only (GitHub did not confirm the merge, so the PR is not ready): show the notes, not an empty blocked box.
  if (n === 0) return notes;
  if (n >= 2) {
    return (
      <details
        className="prblock prblock-fold"
        data-state="blocked"
        open={mergeOpen}
        onToggle={(e) => onMergeToggle(p.repo, e.currentTarget.open)}
      >
        <FoldSummary headline={readiness.headline} blockers={blockers} repo={p.repo} ciBusy={ciBusy} />
        <ul className="prblock-list">
          {readiness.reasons.map((r) => (
            <ReasonRow key={r.kind} r={r} folded repo={p.repo} ciBusy={ciBusy} open={mergeOpen} onToggle={onMergeToggle} />
          ))}
        </ul>
      </details>
    );
  }
  return (
    <div className="prblock" data-state="blocked">
      <div className="prblock-head">
        <Icon name="lock" size={13} />
        <b>{readiness.headline}</b>
        <span className="prblock-count">{`${n} ${n === 1 ? 'reason' : 'reasons'}`}</span>
      </div>
      <ul className="prblock-list">
        {readiness.reasons.map((r) => (
          <ReasonRow key={r.kind} r={r} repo={p.repo} ciBusy={ciBusy} open={mergeOpen} onToggle={onMergeToggle} />
        ))}
      </ul>
    </div>
  );
});
