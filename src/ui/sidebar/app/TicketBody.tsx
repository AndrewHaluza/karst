/**
 * The expanded row's mini-dashboard (peek.ts): head row (strongest summary +
 * quick-action tools), the state-specific context (agent / progress / landing
 * repos / artifacts / meta), and the pinned bottom-right contextual CTA.
 * Archived rows keep their labeled restore/delete pair instead. All of it is
 * host-derived (UI-R31) — the view phrases no domain state.
 */
import type { PeekNext, TicketPeek } from '../peek.js';
import type { TicketRow } from '../state.js';
import { ActButton } from './action.js';
import { AgentIdentity, Icon } from './Icon.js';
import { IconAct } from './IconAct.js';
import { metaLine } from './format.js';
import { MenuTrigger } from './MenuTrigger.js';

/**
 * The expanded toolbar — the SAME actions the collapsed hover strip shows, moved
 * into the head row's top-right so expanding never duplicates them. Spin is
 * ticket-level and shown for every row; the host command owns the real
 * capability rules.
 */
function PeekTools({ row, sessVerb }: { readonly row: TicketRow; readonly sessVerb: string }) {
  const id = row.ticketId;
  return (
    <div className="peek-tools">
      <IconAct spec={{ act: 'spin', id }} label="Spin up worktree and dev servers"><Icon name="player-play" /></IconAct>
      <IconAct spec={{ act: 'open-session', id }} label={`${sessVerb} session`}><Icon name="terminal-2" /></IconAct>
      <IconAct spec={{ act: 'open-dashboard', id }} label="Open ticket dashboard"><Icon name="layout-dashboard" /></IconAct>
      <MenuTrigger row={row} />
    </div>
  );
}

/** The contextual primary next action — a LABELED primary button. */
function NextCta({ next, row }: { readonly next: PeekNext; readonly row: TicketRow }) {
  const spec =
    next.kind === 'resolve-conflicts'
      ? { act: next.kind, id: row.ticketId, repo: next.repo }
      : { act: next.kind, id: row.ticketId };
  return (
    <ActButton spec={spec} className="k-btn k-btn--primary" title={next.label}>
      {next.label}
    </ActButton>
  );
}

function PeekProgress({ progress }: { readonly progress: { passed: number; total: number } }) {
  const pct = Math.min(100, Math.round((progress.passed / progress.total) * 100));
  return (
    <div
      className="peek-progress"
      role="progressbar"
      aria-label="Gate progress"
      aria-valuenow={progress.passed}
      aria-valuemin={0}
      aria-valuemax={progress.total}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function PeekRepos({ repos }: { readonly repos: NonNullable<TicketPeek['repos']> }) {
  return (
    <div className="peek-repos">
      {repos.map((r) => (
        <div className="peek-repo" key={r.repo}>
          {r.number != null && <span className="peek-repo-pr">#{r.number}</span>}
          <span className="peek-repo-name">{r.repo}</span>
          {r.state === 'conflict' ? (
            <span className="peek-repo-state conflict">! Conflicts</span>
          ) : (
            <span className="peek-repo-state ready">✓ Ready</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Captured-artifact count (artifact store): a chip that opens the dashboard. Absent at zero. */
function ArtifactsChip({ row }: { readonly row: TicketRow }) {
  if (!row.artifacts) return null;
  const n = Number(row.artifacts);
  return (
    <ActButton spec={{ act: 'open-dashboard', id: Number(row.ticketId) }} className="peek-artifacts" title="Open the dashboard to browse captured artifacts">
      {n} artifact{n === 1 ? '' : 's'}
    </ActButton>
  );
}

/** Archived rows keep their labeled restore/delete pair — the live toolbar only exists for active rows. */
function ArchivedBar({ row }: { readonly row: TicketRow }) {
  return (
    <div className="actions">
      <ActButton spec={{ act: 'unarchive', id: row.ticketId }} className="k-btn k-btn--secondary" title="Restore ticket to the active list">
        <Icon name="history" /> Unarchive
      </ActButton>
      <ActButton spec={{ act: 'delete', id: row.ticketId }} className="k-btn k-btn--danger" title="Delete ticket permanently">
        <Icon name="trash" /> Delete
      </ActButton>
    </div>
  );
}

export function TicketBody({ row, sessVerb }: { readonly row: TicketRow; readonly sessVerb: string }) {
  const b = row.blocker;
  // Only the failure REASON is new — the status is already the row's glyph color.
  const blocker =
    b && (b.reason || b.attempt) ? (
      <div className="nextact warn">
        ⚠ {b.reason || ''}
        {b.attempt ? <span className="att">attempt {b.attempt}</span> : null}
      </div>
    ) : null;
  const peek = row.peek;
  const meta = metaLine(row);
  const metaEl = meta ? <div className="meta">{meta}</div> : null;
  return (
    <div className="body">
      {blocker}
      {!row.archived && peek && (
        <>
          <div className="peek">
            <div className="peek-head">
              <div className="peek-copy">
                <div className="peek-title">{peek.title}</div>
                {peek.detail ? <div className="peek-detail">{peek.detail}</div> : null}
              </div>
              <PeekTools row={row} sessVerb={sessVerb} />
            </div>
            {peek.progress && peek.progress.total > 0 ? <PeekProgress progress={peek.progress} /> : null}
            <div className="peek-sep" />
            {peek.agent && peek.agent.provider ? <AgentIdentity provider={peek.agent.provider} model={peek.agent.model} /> : null}
            {peek.repos && peek.repos.length ? <PeekRepos repos={peek.repos} /> : null}
            <ArtifactsChip row={row} />
            {metaEl}
          </div>
          {peek.next ? (
            <div className="peek-actions">
              <NextCta next={peek.next} row={row} />
            </div>
          ) : null}
        </>
      )}
      {row.archived ? metaEl : null}
      {row.archived ? <ArchivedBar row={row} /> : null}
    </div>
  );
}
