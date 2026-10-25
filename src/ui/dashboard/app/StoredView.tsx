/**
 * The Captured artifacts view (T2 store): the stored files of the ticket, grouped kind then approach. Every action carries
 * the STORE path and revision shas only; the host re-resolves both (ops/storedArtifactOps.ts). Each posting control is
 * runtime-pending and settles on the host's `action-result`; its className is constant.
 */
import { Fragment, memo, useCallback } from 'react';
import type { StoredArtifactRow } from '../storedArtifacts.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { BackButton, useHeading } from './ArtifactParts.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';

const selectStored = (snapshot: DashboardSnapshot) => snapshot.state?.storedArtifacts ?? null;

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

const GHOST = 'k-btn k-btn--ghost k-btn--sm';

function OpenButton({ path, sha, label, title }: { readonly path: string; readonly sha: string; readonly label: string; readonly title: string }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.storedArtifactOpen(path, sha, requestId), [send, path, sha]));
  return (
    <button type="button" className={GHOST} data-act="stored-artifact-open" data-path={path} data-sha={sha} title={title} onClick={onClick}>
      {label}
    </button>
  );
}

function DiffButton({ path, from, to }: { readonly path: string; readonly from: string; readonly to: string }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.storedArtifactDiff(path, from, to, requestId), [send, path, from, to]));
  return (
    <button type="button" className={GHOST} data-act="stored-artifact-diff" data-path={path} data-from={from} data-to={to} title="Show changes since the previous revision" onClick={onClick}>
      Diff vs previous
    </button>
  );
}

function LiveButton({ path }: { readonly path: string }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.storedArtifactLive(path, requestId), [send, path]));
  return (
    <button type="button" className={GHOST} data-act="stored-artifact-live" data-path={path} title="Open the worktree file, if it still exists" onClick={onClick}>
      Open live file
    </button>
  );
}

const Row = memo(function Row({ r }: { readonly r: StoredArtifactRow }) {
  return (
    <li className="sa-row">
      <div className="sa-main">
        <span className="sa-path">{`${r.repo} / ${r.relPath}`}</span>
        <span className="sa-chip">{r.approach}</span>
        <span className="sa-chip">{r.source}</span>
        <span className="sa-meta">{`${Number(r.revisions)} revision${Number(r.revisions) === 1 ? '' : 's'} · ${when(r.lastAt)}`}</span>
      </div>
      <div className="sa-main">
        <OpenButton path={r.path} sha={r.latestSha} label="Open latest" title="Open the latest revision read-only" />
        <LiveButton path={r.path} />
      </div>
      <details className="sa-hist">
        <summary>History</summary>
        <ul className="artrows">
          {r.history.map((h, i) => {
            const older = r.history[i + 1];
            return (
              <li key={h.sha} className="sa-rev">
                <span className="sa-meta">{when(h.at)}</span>
                <span className="sa-chip">{h.source}</span>
                <OpenButton path={r.path} sha={h.sha} label="Open" title="Open this revision read-only" />
                {older ? <DiffButton path={r.path} from={older.sha} to={h.sha} /> : null}
              </li>
            );
          })}
        </ul>
      </details>
    </li>
  );
});

function Bar() {
  const send = useDashboardSend();
  const reveal = usePendingAction(useCallback((requestId: string) => send.storedArtifactReveal(requestId), [send]));
  const purge = usePendingAction(useCallback((requestId: string) => send.storedArtifactPurge(requestId), [send]));
  return (
    <span className="sa-bar">
      <button type="button" className={GHOST} data-act="stored-artifact-reveal" title="Check out the latest files read-only and show the folder" onClick={reveal}>
        Reveal folder
      </button>
      <button type="button" className={GHOST} data-act="stored-artifact-purge" title="Delete every stored revision for this ticket" onClick={purge}>
        Purge artifacts
      </button>
    </span>
  );
}

export function StoredView() {
  const v = useSlice(selectStored);
  const heading = useHeading();
  const head = (
    <div className="arthead">
      <BackButton to="ticket" />
      <h2>{heading}</h2>
      <span className="artsub">{`Artifacts · ${v ? Number(v.total) : 0}`}</span>
      <Bar />
    </div>
  );
  if (!v) {
    return (
      <>
        {head}
        <p className="sa-empty">Loading…</p>
      </>
    );
  }
  return (
    <>
      {head}
      {v.total === 0 ? (
        <p className="sa-empty">
          {v.globs.length ? 'No artifacts captured yet. Watching: ' : 'No artifacts captured yet. No outputs globs are configured for the enabled approaches.'}
          {v.globs.map((g, i) => (
            <Fragment key={g}>
              {i > 0 ? ', ' : null}
              <code>{g}</code>
            </Fragment>
          ))}
          {v.globs.length ? '.' : null}
        </p>
      ) : (
        v.groups.map((g) => (
          <section key={g.kind} className="artgroup" aria-label={`${g.kind} artifacts`}>
            <div className="artgroup-title">{g.kind}</div>
            {g.approaches.map((a) => (
              <Fragment key={a.approach}>
                <div className="sa-meta">{a.approach}</div>
                <ul className="artrows">
                  {a.rows.map((r) => (
                    <Row key={r.path} r={r} />
                  ))}
                </ul>
              </Fragment>
            ))}
          </section>
        ))
      )}
      {v.skips.length ? (
        <section className="artgroup" aria-label="Skipped files">
          <div className="artgroup-title">Skipped files</div>
          {v.skips.map((k) => (
            <div key={k.path} className="sa-skip">{`${k.path} — ${k.reason}`}</div>
          ))}
        </section>
      ) : null}
    </>
  );
}
