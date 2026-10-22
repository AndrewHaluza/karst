import type { Store } from '../store/db.js';
import { recordGateRun } from '../store/gateRuns.js';
import { finishProcessRun, openProcessRun } from '../store/processRuns.js';
import { openRecoveryRound } from '../store/recoveryRoundsWrite.js';
import { setStage } from '../store/stages.js';
import { closeStageRun, openStageRun } from '../store/stageRuns.js';
import { archiveTicket, createTicket, setStageCurrent, updateTicketFields } from '../store/tickets.js';
import type { FixtureSpec, RowSeeds } from './fixtures.js';

const AT = '2026-01-01T00:00:00.000Z';
const WORKTREE_REPO = '/fixture/repo';

function seedRows(store: Store, ticketId: number, rows: Partial<RowSeeds>): void {
  const stageRunIds = (rows.stageRuns ?? []).map((r, i) => {
    const id = openStageRun(store, { ticketId, stageKey: r.stageKey, attempt: r.attempt, runAt: `${AT}#${i}`, startedAt: AT });
    if (r.status === 'finished') closeStageRun(store, id, r.outcome ?? 'stopped', AT);
    return id;
  });
  for (const r of rows.processRuns ?? []) {
    const run = openProcessRun(store, {
      ticketId, stageKey: r.stageKey, processId: r.processId, attempt: r.attempt, startedAt: AT,
      ...(r.stageRun === undefined ? {} : { stageRunId: stageRunIds[r.stageRun]! }),
    });
    if (r.status !== 'running') finishProcessRun(store, run.id, r.status, AT);
  }
  for (const r of rows.gateRuns ?? []) {
    recordGateRun(store, {
      ticketId, stageKey: r.stageKey, attempt: r.attempt, runAt: AT,
      gates: [{ gateName: r.gateName, exitCode: r.exitCode }],
      ...(r.stageRun === undefined ? {} : { stageRunId: stageRunIds[r.stageRun]! }),
    });
  }
  for (const r of rows.recoveryRounds ?? []) {
    openRecoveryRound(store, {
      ticketId, ...r, sourceStageRunId: null, sourceProcessRunId: null, startedAt: AT,
    });
  }
}

/** Seeds through the store APIs (never raw SQL) so the schema's own rules hold. */
export function seedStore(store: Store, spec: FixtureSpec): number[] {
  return spec.tickets.map((seed) => {
    const ticket = createTicket(store, { key: seed.key, title: seed.title });
    setStageCurrent(store, ticket.id, seed.stageCurrent);
    if (seed.selectedRepos) updateTicketFields(store, ticket.id, { selectedRepos: seed.selectedRepos });
    for (const s of seed.stages) setStage(store, ticket.id, s.stageKey, s.patch);
    if (seed.worktree) {
      store.db
        .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
        .run(ticket.id, WORKTREE_REPO, `${WORKTREE_REPO}/.karst/worktrees/${seed.key}`, `karst/${seed.key}`, 'main');
    }
    if (seed.rows) seedRows(store, ticket.id, seed.rows);
    if (seed.archived) archiveTicket(store, ticket.id);
    return ticket.id;
  });
}
