import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { getTicket, updateTicketFields } from '../store/tickets.js';
import { createTicketFlow } from './stages/create.js';
import { scopeTicket } from './stages/scope.js';
import { markImplementDone } from './stages/implement.js';
import { runUat, type UatDeps } from './stages/uat.js';
import { runReview, type ReviewDeps } from './stages/review.js';
import { runFix } from './stages/fix.js';
import { shipTicket } from './stages/ship.js';
import { advanceTicketOnShip } from './stages/done.js';
import { transition } from './machine.js';
import { settleShipGate } from './mergeGate.js';
import { reconcileOnStart, deriveStageCurrent } from '../recovery/reconcile.js';
import type { TicketingProvider } from '../integrations/ticketing.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { GhRunner } from '../integrations/github.js';
import type { GitRunner } from '../integrations/git.js';
import { manifest as buildManifest, runnableRepo } from '../manifest/fixtures.js';
import { runStageCommand } from '../cli/stage.js';
import { BUILT_IN_PACKAGE_ID } from '../approaches/builtInId.js';
import { stageAttempt } from '../store/stages.js';

/**
 * MVP definition-of-done (plan line 474), driven over the REAL stage modules and
 * store — deterministic (injected runners, no live servers): create -> scope ->
 * impl -> uat -> review (with a fix/UAT revalidation loop) -> ship -> done, then reopen and prove
 * no ticket lost its stage. The live-server half (spin) is covered by
 * spin.integration.test.ts; this proves the workflow spine end to end.
 */

/**
 * UAT's gates are resolved per repository at runtime, so the spine fakes the
 * probe (which scripts exist) and the runner (what they exit with) and leaves the
 * real resolution, aggregation and transition in the path.
 */
function uatDeps(exitCode: number): UatDeps {
  return {
    probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } }),
    runGates: async (gates) => ({
      kind: 'ran',
      results: gates.map((g) => ({ name: g.name, exitCode, output: exitCode === 0 ? 'green' : 'red' })),
    }),
  };
}
const PASS = uatDeps(0);
const FAIL = uatDeps(1);
/**
 * Review resolves its gates from the same package.json probe UAT does, so the
 * spine fakes the probe and the runner and leaves resolution, aggregation and
 * transition real. `lint`/`typecheck` are what make this review ask something
 * UAT (which probes `test`/`e2e`) does not — the independence rule of §6.4 R7.
 */
const adapter: AgentAdapter = {
  runHeadless: async () => ({ sessionId: 's', verdict: null, raw: '[]' }),
  buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
  requiredBinary: 'claude',
  capabilities: { lifecycleEvents: true, resume: true },
};

/**
 * The findings lane (Lane B) defaults to ON (constraints.md), so this spine
 * needs an agent core wired for review or every gate-clean run would park
 * capability-missing instead of reaching ship. `adapter`'s raw output ('[]')
 * is a clean, recognized-empty findings answer — this spine is about the
 * STAGE MACHINE, not Lane B (which has its own dedicated coverage in
 * `stages/review.test.ts`), and an unreadable answer now blocks review
 * (R6b) rather than degrading to a gate-decided verdict, so this fixture
 * must answer readably to keep exercising the stage machine past review.
 */
function reviewDeps(exitCode: number): ReviewDeps {
  return {
    probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'vitest' } }),
    runGates: async (gates) => ({
      kind: 'ran',
      results: gates.map((g) => ({
        name: g.name,
        exitCode,
        output: exitCode === 0 ? 'ok' : 'red',
      })),
    }),
    findingsAdapter: adapter,
  };
}
const GATES_PASS = reviewDeps(0);
const GATES_FAIL = reviewDeps(1);
// `pr view` is ship's "already shipped?" probe; a fresh branch has no PR, which
// gh reports as a nonzero exit. Answered explicitly rather than letting the
// create response stand in for it.
const gh: GhRunner = async (args) =>
  args[1] === 'view'
    ? { stdout: '', stderr: 'no pull requests found', exitCode: 1 }
    : { stdout: 'https://github.com/o/r/pull/1', exitCode: 0 };

describe('MVP lifecycle (workflow spine)', () => {
  let store: Store;
  let dir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'karst-lifecycle-'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drives a ticket create -> ... -> done, with a review fix/UAT revalidation loop, surviving reopen', async () => {
    // create
    const id = createTicketFlow(store, { key: 'PROJ-142', title: 'add search' }).id;
    expect(getTicket(store, id).stageCurrent).toBe('scope');

    // scope (frontend-only, no migration warning) -> impl
    const manifest = buildManifest(
      { frontend: runnableRepo({}, { repoPath: '/repo/fe' }) },
      { portRange: [4000, 4100] },
    );
    expect(scopeTicket(manifest, ['frontend']).warnings).toEqual([]);
    transition(store, id, 'scope', { kind: 'passed' }); // -> impl

    // implement boundary (explicit marker) -> uat
    expect(markImplementDone(store, id)).toBe('uat');

    // uat passes -> review
    await runUat(store, { ticketId: id, cwd: '/wt', artifactDir: dir }, PASS);
    expect(getTicket(store, id).stageCurrent).toBe('review');

    // review FAILS -> fix, then fix resumes -> UAT revalidation -> review -> ship
    store.db.prepare('UPDATE tickets SET session_id = ? WHERE id = ?').run('sess-1', id);
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir: dir }, GATES_FAIL);
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(getTicket(store, id).stages.find((s) => s.stageKey === 'review')!.attempt).toBe(1);

    await runFix(store, { ticketId: id, cwd: '/wt' }, adapter); // -> uat
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    await runUat(store, { ticketId: id, cwd: '/wt', artifactDir: dir }, PASS); // -> review
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir: dir }, GATES_PASS);
    expect(getTicket(store, id).stageCurrent).toBe('ship');

    // ship (one hot repo) -> done, gated on the PR being merged
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/repo/fe', ?, 'b', 'develop', 'inherited')",
      )
      .run(id, join(dir, 'fe'));
    // Ship pushes the branch before opening the PR; this spine exercises the
    // workflow, not the network, so git is faked alongside gh.
    const git: GitRunner = async (args) => ({
      stdout: '',
      stderr: '',
      exitCode: args[0] === 'diff' ? 1 : 0,
    });
    const shipRes = await shipTicket(store, { ticketId: id }, gh, adapter, git);
    expect(shipRes.prs).toHaveLength(1);
    // Shipping opens the PR; it does NOT land it. The ticket stays parked at
    // `ship`, blocked on the merge gate, until the PR reads merged — `done` has
    // no edge into it until then.
    expect(getTicket(store, id).stageCurrent).toBe('ship');
    expect(settleShipGate(store, id).advanced).toBe(false);

    // the PR lands (here: a teammate merged it, which the PR sweep would record)
    store.db.prepare("UPDATE prs SET status = 'merged' WHERE ticket_id = ?").run(id);
    expect(settleShipGate(store, id).advanced).toBe(true);
    expect(getTicket(store, id).stageCurrent).toBe('done');

    // update the external ticket status via the provider seam — addressed by the
    // provider's own ref, which a fetched ticket carries.
    updateTicketFields(store, id, { sourceRef: 'CU-abc123' });
    const updates: { ref: string; status: string }[] = [];
    const provider: TicketingProvider = {
      async updateStatus(ref, status) {
        updates.push({ ref, status });
      },
    };
    const advanced = await advanceTicketOnShip(
      store,
      id,
      { provider: 'clickup', advanceOnShip: true, shipStatus: 'done' },
      provider,
    );
    expect(advanced).toEqual({ advanced: true, status: 'done' });
    expect(updates).toEqual([{ ref: 'CU-abc123', status: 'done' }]);

    // reopen: reconcile must keep the ticket at done (no stage lost)
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('scope', id); // simulate drift
    reconcileOnStart(store, () => false);
    expect(getTicket(store, id).stageCurrent).toBe('done');
    expect(deriveStageCurrent(getTicket(store, id).stages)).toBe('done');
  });

  it('a UAT failure routes to fix (deterministic, exit-code driven)', async () => {
    const id = createTicketFlow(store, { key: 'P-2', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    markImplementDone(store, id);
    await runUat(store, { ticketId: id, cwd: '/wt', artifactDir: dir }, FAIL);
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });
});

describe('Abandoned graph run — direct ticket can pass impl', () => {
  let store: Store;
  let dir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'karst-abandoned-graph-'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a direct-approach ticket with a cancelled graph run can pass impl', () => {
    const id = createTicketFlow(store, { key: 'E2E-1', title: 'e2e' }).id;
    // Set up as direct approach with a cancelled graph run (simulating abandoned attempt)
    transition(store, id, 'scope', { kind: 'passed' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl', approach = 'direct' WHERE id = ?").run(id);
    store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(id);
    const attempt = stageAttempt(store, id, 'impl');
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
         VALUES (?, 'impl', ?, 'x', 'cancelled', 'abandoned: gateway node claimed dbgw paths against the web-contract domain', '2026-08-12T00:00:00.000Z')`,
      )
      .run(id, attempt);

    // Fire impl marker — should succeed via markImplementDone, not graph guard
    const nextStage = runStageCommand(store, id, ['stage', 'impl', 'pass']);
    expect(nextStage).toBe('uat');

    // Verify ticket advanced
    const ticket = store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(id) as { stage_current: string };
    expect(ticket.stage_current).toBe('uat');
  });

  it('a graph-approach ticket with cancelled run is refused with clear message', () => {
    const id = createTicketFlow(store, { key: 'E2E-2', title: 'e2e graph' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl', approach = ? WHERE id = ?").run(BUILT_IN_PACKAGE_ID, id);
    store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(id);
    const attempt = stageAttempt(store, id, 'impl');
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', ?, 'x', 'cancelled', 'abandoned', '2026-08-12T00:00:00.000Z')`,
        )
        .run(id, attempt)
        .lastInsertRowid,
    );
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId);

    expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(
      /graph marker refused: graph run \d+ is cancelled — a terminal state, so it will never become marker-ready/,
    );
  });
});
