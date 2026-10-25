/**
 * The advisory preview of what ship's sweep commit and PR will do (D142), shown ONLY while the header's ship slot
 * waits for Confirm / Retry, above the process ledger in the Ship view (UI-R40 reading order): it is the first thing
 * read before the Confirm click. Every fact is the host's (UI-R31); this layer only formats, escapes (UI-R32) and caps.
 *
 * Refresh asks the host to re-read every worktree: it shows the click landed and cannot repeat, and settles on the
 * next settling push (the host sends one after the read, changed or not).
 */
import { memo, useCallback, type MouseEvent, type ReactNode } from 'react';
import type { ShipPreview as Preview, ShipPreviewRepo } from '../../../workflow/shipPreview.js';
import { useDashboardSend, useOps, usePendingOps } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { beginPending } from './usePendingAction.js';

const FILE_CAP = 50;

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Badge({ r }: { readonly r: ShipPreviewRepo }) {
  // A read failure means the repo's state was never determined, so the badge must not claim a verdict.
  const [cls, icon, word] = r.error
    ? ['sp-badge', 'circle-x', 'not read']
    : r.status === 'blocked'
      ? ['sp-badge sp-badge--danger', 'circle-x', 'blocked']
      : r.status === 'already-shipped'
        ? ['sp-badge sp-badge--ok', 'circle-check', 'PR open — skipped']
        : r.status === 'already-merged'
          ? ['sp-badge sp-badge--ok', 'circle-check', 'merged — nothing to ship']
          : r.status === 'will-commit'
            ? ['sp-badge sp-badge--ok', 'circle-check', 'will commit']
            : ['sp-badge', 'check', 'nothing to commit'];
  return (
    <span className={cls}>
      <Icon name={icon!} size={14} />
      <span>{word}</span>
    </span>
  );
}

function Row({ label, children, cls }: { readonly label: string; readonly children: ReactNode; readonly cls?: string }) {
  return (
    <div className={cls ? `sp-row ${cls}` : 'sp-row'}>
      <span className="sp-label">{label}</span>
      <span className="sp-value">{children}</span>
    </div>
  );
}

function Files({ label, files, note }: { readonly label: string; readonly files: readonly string[]; readonly note: string }) {
  const n = files.length;
  const shown = files.slice(0, FILE_CAP);
  const more = n - shown.length;
  return (
    <Row label={label}>
      <details className="sp-files">
        <summary>{`${n} ${n === 1 ? 'file' : 'files'}${note ? ` ${note}` : ''}`}</summary>
        <ul className="sp-file-list">
          {shown.map((f) => (
            <li className="sp-file" key={f}>
              {f}
            </li>
          ))}
          {more > 0 ? <li className="sp-file sp-more">{`and ${more} more`}</li> : null}
        </ul>
      </details>
    </Row>
  );
}

const prNumber = (r: ShipPreviewRepo): string => String(r.prNumber == null ? '?' : r.prNumber);

function Repo({ r }: { readonly r: ShipPreviewRepo }) {
  const denied = (r.deny || []).join(', ');
  return (
    <section className="sp-repo" data-region="ship-preview-repo">
      <div className="sp-repo-head">
        <span className="sp-repo-name">{r.repo}</span>
        <Badge r={r} />
      </div>
      <div className="sp-grid">
        {r.status === 'blocked' ? (
          <div className="sp-row sp-row--danger">
            <span className="sp-label">
              <Icon name="circle-x" size={14} />
              <span>Blocked</span>
            </span>
            <span className="sp-value">{`ship refuses ${denied || 'untracked secret-shaped files'} — commit them deliberately or ignore them`}</span>
          </div>
        ) : r.status === 'already-shipped' ? (
          <Row label="Status">{`PR #${prNumber(r)} open — skipped`}</Row>
        ) : r.status === 'already-merged' ? (
          <Row label="Status">{`merged in #${prNumber(r)} — nothing to ship`}</Row>
        ) : r.status === 'nothing-to-commit' && !r.error ? (
          // Never a verdict on a failed read: `r.error` renders its own row below.
          <Row label="Status">{r.changedFromBase ? 'nothing to commit — agent committed its work' : 'no changes from base'}</Row>
        ) : null}
        {/* A re-ship: a live PR exists but ship will commit and push into it (FIX-46), so the repo is NOT skipped. */}
        {r.prNumber != null && r.status !== 'already-shipped' && !r.error ? <Row label="PR">{`PR #${r.prNumber} open — this commit is pushed onto it`}</Row> : null}
        <Row label="PR title">{r.prTitle}</Row>
        <Row label="Commit">{r.commitMessage}</Row>
        {/* A blocked repo will not commit at all (ship refuses before the sweep), so listing its dirty paths under "Commits" would claim work ship will never do. */}
        {r.status !== 'blocked' && r.commitFiles && r.commitFiles.length ? <Files label="Commits" files={r.commitFiles} note="" /> : null}
        {r.excludedFiles && r.excludedFiles.length ? <Files label="Excluded" files={r.excludedFiles} note="(ship.exclude)" /> : null}
        {r.committedExcludedWarning && r.committedExcludedWarning.length ? (
          <Row label="Warning" cls="sp-row--warn">{`ship.exclude matches committed changes: ${r.committedExcludedWarning.join(', ')} — these DO ship`}</Row>
        ) : null}
        {r.error ? <Row label="Error">{r.error}</Row> : null}
      </div>
    </section>
  );
}

function Skeleton() {
  const row = (
    <div className="sp-row sp-skel-row">
      <span className="sp-label" />
      <span className="sp-value">
        <span className="sp-skel" />
      </span>
    </div>
  );
  return (
    <div className="sp-repo" data-region="ship-preview-repo" aria-hidden="true">
      <div className="sp-repo-head">
        <span className="sp-skel sp-skel-name" />
      </div>
      <div className="sp-grid">
        {row}
        {row}
        {row}
      </div>
    </div>
  );
}

function Body({ preview }: { readonly preview: Preview }) {
  const repos = preview.repos || [];
  // @arch:SHIP-UNCHANGED: ship fails when EVERY target is unchanged. A repo skipped for a live PR, blocked, or failed is
  // not counted, so the line only shows when every repo is a genuine no-change.
  const allNothing = repos.length > 0 && repos.every((r) => r.status === 'nothing-to-commit' && !r.error && !r.changedFromBase);
  return (
    <>
      {allNothing ? (
        <p className="sp-note sp-note--warn">
          <Icon name="circle-x" size={14} />
          <span>ship will fail — no repo has changes</span>
        </p>
      ) : null}
      {repos.length ? (
        repos.map((r) => <Repo r={r} key={r.repo} />)
      ) : (
        <p className="sp-note">
          <span>No repositories on this ticket.</span>
        </p>
      )}
    </>
  );
}

export const ShipPreview = memo(function ShipPreview({ preview }: { readonly preview: Preview | null }) {
  const send = useDashboardSend();
  const ops = usePendingOps();
  const refreshing = useOps().running.has('previewRefresh');
  const onRefresh = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (ops.isRunning('previewRefresh')) return;
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginAction('previewRefresh', requestId);
      send.refreshShipPreview();
    },
    [ops, send],
  );
  return (
    <section className="ship-preview" data-region="ship-preview" aria-labelledby="ship-preview-title">
      <div className="sp-head">
        <span className="sp-title" id="ship-preview-title">
          Ship preview
        </span>
        <span className="sp-meta">{preview ? `as of ${when(preview.computedAt)}` : 'reading…'}</span>
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--sm"
          data-act="refresh-ship-preview"
          aria-busy={refreshing ? 'true' : 'false'}
          disabled={refreshing}
          title="Re-read the worktrees now"
          onClick={onRefresh}
        >
          Refresh
        </button>
      </div>
      {preview ? <Body preview={preview} /> : <Skeleton />}
    </section>
  );
});
