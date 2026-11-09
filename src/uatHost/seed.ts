import { recordPlacement } from '../store/placement.js';
import type { Store } from '../store/db.js';
import { recordGateRun } from '../store/gateRuns.js';
import { finishProcessRun, openProcessRun } from '../store/processRuns.js';
import { recordFindings } from '../store/reviewFindings.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import { recordShippedPr, updatePrDetail } from '../store/prs.js';
import { openRecoveryRound } from '../store/recoveryRoundsWrite.js';
import { setStage } from '../store/stages.js';
import { closeStageRun, openStageRun } from '../store/stageRuns.js';
import { archiveTicket, createTicket, setStageCurrent, updateTicketFields } from '../store/tickets.js';
import { UNKNOWN_PR_DETAIL } from '../integrations/github.js';
import type { FixtureSpec, RepoBinding, RowSeeds } from './fixtures.js';

const AT = '2026-01-01T00:00:00.000Z';
const DEFAULT_BINDING: RepoBinding = { repoPath: '/fixture/repo', baseRef: 'main', worktreePath: '' };

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
  for (const r of rows.prs ?? []) {
    recordShippedPr(store, { ticketId, repo: r.repo, number: r.number, url: r.url });
    updatePrDetail(store, {
      ticketId, repo: r.repo, url: r.url,
      detail: {
        ...UNKNOWN_PR_DETAIL, status: r.status, headRef: r.headRef ?? null, baseRef: r.baseRef ?? null,
        mergeBlock: r.mergeBlock ?? 'unknown',
      },
    });
  }
  for (const r of rows.mergeChecks ?? []) setMergeCheck(store, { ticketId, ...r, checkedAt: AT });
  for (const r of rows.reviewFindings ?? []) {
    recordFindings(store, {
      ticketId, attempt: r.attempt, runAt: `${AT}#a${r.attempt}`,
      findings: [{ severity: r.severity, repo: r.repo, file: r.file, line: r.line, title: r.title, detail: r.detail, source: r.source }],
    });
  }
}

/** Seeds through the store APIs (never raw SQL) so the schema's own rules hold. */
export function seedStore(store: Store, spec: FixtureSpec, defaults?: { repoPath: string }): number[] {
  const fallback: RepoBinding = { ...DEFAULT_BINDING, ...(defaults ?? {}) };
  return spec.tickets.map((seed) => {
    const ticket = createTicket(store, { key: seed.key, title: seed.title, ...(seed.description === undefined ? {} : { description: seed.description }) });
    setStageCurrent(store, ticket.id, seed.stageCurrent);
    if (seed.selectedRepos) updateTicketFields(store, ticket.id, { selectedRepos: seed.selectedRepos });
    for (const s of seed.stages) setStage(store, ticket.id, s.stageKey, s.patch);
    if (seed.placement) recordPlacement(store, ticket.id, { backend: seed.placement, core: null, sandboxName: null, reason: null }, null);
    if (seed.worktree) {
      const binding = seed.repo ?? fallback;
      store.db
        .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
        .run(ticket.id, seed.worktreeRepo ?? binding.repoPath, binding.worktreePath || `${binding.repoPath}/.karst/worktrees/${seed.key}`, `karst/${seed.key}`, binding.baseRef);
    }
    if (seed.rows) seedRows(store, ticket.id, seed.rows);
    if (seed.archived) archiveTicket(store, ticket.id);
    return ticket.id;
  });
}
