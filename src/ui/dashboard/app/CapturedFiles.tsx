/**
 * Captured files (T2 store) inside the one Artifacts list. A file whose Karst-Kind names a semantic artifact folds into
 * that artifact's detail; every other file is an ordinary index row under its resolved stage. Every action carries the
 * STORE path and revision shas only; the host re-resolves both (ops/storedArtifactOps.ts). Each posting control is
 * runtime-pending and settles on the host's `action-result`; its className is constant.
 */
import { memo, useCallback, useMemo } from 'react';
import type { StoredArtifactRow } from '../storedArtifacts.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';
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

export const CapturedRow = memo(function CapturedRow({ r }: { readonly r: StoredArtifactRow }) {
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

export function CapturedActions() {
  const send = useDashboardSend();
  const reveal = usePendingAction(useCallback((requestId: string) => send.storedArtifactReveal(requestId), [send]));
  const purge = usePendingAction(useCallback((requestId: string) => send.storedArtifactPurge(requestId), [send]));
  return (
    <span className="sa-bar">
      <button type="button" className={GHOST} data-act="stored-artifact-reveal" title="Check out the latest files read-only and show the folder" onClick={reveal}>
        Reveal folder
      </button>
      <button type="button" className={GHOST} data-act="stored-artifact-purge" title="Delete every stored revision for this ticket" onClick={purge}>
        Purge files…
      </button>
    </span>
  );
}


const selectView = (snapshot: DashboardSnapshot) => snapshot.state?.storedArtifacts ?? null;

/** Every captured file of the ticket, flat; empty until the host's first load answers. */
export function useCaptured(): readonly StoredArtifactRow[] {
  const view = useSlice(selectView);
  return useMemo(() => (view ? view.groups.flatMap((g) => g.approaches.flatMap((a) => a.rows)) : []), [view]);
}
