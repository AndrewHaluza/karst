import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { getTicket, updateTicketOnboarding } from '../store/tickets.js';
import { createTicketFlow } from './stages/create.js';
import { scopeTicket } from './stages/scope.js';
import { markImplementDone } from './stages/implement.js';
import { runUat, type TestRunner } from './stages/uat.js';
import { runReview, type GateRunner } from './stages/review.js';
import { runFix } from './stages/fix.js';
import { shipTicket } from './stages/ship.js';
import { advanceTicketOnShip } from './stages/done.js';
import { transition } from './machine.js';
import { reconcileOnStart, deriveStageCurrent } from '../recovery/reconcile.js';
import type { TicketingProvider } from '../integrations/ticketing.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { GhRunner } from '../integrations/github.js';
import type { GitRunner } from '../integrations/git.js';
import { manifest as buildManifest, runnableRepo } from '../manifest/fixtures.js';

/**
 * MVP definition-of-done (plan line 474), driven over the REAL stage modules and
 * store — deterministic (injected runners, no live servers): create -> scope ->
 * impl -> uat -> review (with a fix/UAT revalidation loop) -> ship -> done, then reopen and prove
 * no ticket lost its stage. The live-server half (spin) is covered by
 * spin.integration.test.ts; this proves the workflow spine end to end.
 */

const PASS: TestRunner = async () => ({ exitCode: 0, output: 'green' });
const FAIL: TestRunner = async () => ({ exitCode: 1, output: 'red' });
const GATES_PASS: GateRunner = async () => [
  { name: 'lint', exitCode: 0, output: 'ok' },
  { name: 'typecheck', exitCode: 0, output: 'ok' },
  { name: 'test', exitCode: 0, output: 'ok' },
];
const GATES_FAIL: GateRunner = async () => [
  { name: 'lint', exitCode: 1, output: 'lint broke' },
  { name: 'typecheck', exitCode: 0, output: 'ok' },
  { name: 'test', exitCode: 0, output: 'ok' },
];

const adapter: AgentAdapter = {
  runHeadless: async () => ({ sessionId: 's', verdict: null, raw: 'PR body.' }),
  buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
  requiredBinary: 'claude',
  capabilities: { lifecycleEvents: true, resume: true },
};
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

    // ship (one hot repo) -> done
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
    expect(getTicket(store, id).stageCurrent).toBe('done');

    // update the external ticket status via the provider seam — addressed by the
    // provider's own ref, which a fetched ticket carries.
    updateTicketOnboarding(store, id, { sourceRef: 'CU-abc123' });
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
