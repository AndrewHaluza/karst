import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { manifest, uat as uatConfig } from '../../manifest/fixtures.js';
import { runUat, type UatDeps } from './uat.js';

const now = () => '2026-07-30T10:00:00.000Z';

function deps(over: Partial<UatDeps> = {}): UatDeps {
  return {
    now,
    planTargets: async () => ({ kind: 'targets', targets: [{ repo: '/web', path: '/wt/web', names: ['web'] }] }),
    probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } }),
    runGates: async (gates) => ({
      kind: 'ran',
      results: gates.map((g) => ({ name: g.name, exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() })),
    }),
    ...over,
  };
}

function uatStage(store: Store, id: number) {
  return getTicket(store, id).stages.find((s) => s.stageKey === 'uat')!;
}

describe('runUat', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-uat-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('all gates green -> advances to review and records one row per gate', async () => {
    const res = await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    // Every row carries repository identity, or a failure names no place. With no
    // manifest the target is the bare cwd, so the label is the path.
    expect(listGateRuns(store, id).map((r) => r.gateName).sort()).toEqual([
      'e2e (/wt/web)',
      'test (/wt/web)',
    ]);
  });

  it('a failing gate -> routes to fix and files evidence under the attempt that ran', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({
            name: g.name,
            exitCode: g.name === 'e2e' ? 1 : 0,
            output: 'boom',
            startedAt: now(),
            endedAt: now(),
          })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(listGateRuns(store, id).every((r) => r.attempt === 0)).toBe(true);
    expect(uatStage(store, id).attempt).toBe(1);
  });

  it('nothing to run -> blocks, does not transition, consumes no attempt', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { build: 'tsc' } }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
    expect(stageBlock(store, id, 'uat')?.kind).toBe('nothing-to-run');
  });

  it('an unreadable repository -> blocks capability-missing', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'io-error', message: 'EACCES' }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
  });

  it('a stopped run yields no verdict and no attempt', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ runGates: async () => ({ kind: 'stopped', results: [] }) }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
  });

  it('writes the overlap warning into the artifact when nothing is independent', async () => {
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        probe: () => ({ kind: 'ok', scripts: { test: 'vitest' } }),
      }),
    );
    const path = uatStage(store, id).artifactPath!;
    expect(readFileSync(path, 'utf8')).toContain('asked no question review does not');
  });

  it('clears a previous block when a fresh run reaches a verdict', async () => {
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { build: 'tsc' } }) }),
    );
    expect(stageBlock(store, id, 'uat')).not.toBeNull();
    await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(stageBlock(store, id, 'uat')).toBeNull();
  });

  // `planTargets` is consulted ONLY when a manifest is supplied — without one
  // there is nothing to resolve repository names against, so runUat falls back to
  // the single cwd. Passing a manifest here is what puts the planner in the path.
  it('runs every target and aggregates only after all of them complete', async () => {
    const ran: string[] = [];
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        }),
        runGates: async (gates, cwd) => {
          ran.push(cwd);
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(ran.sort()).toEqual(['/wt/api', '/wt/web']);
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  // A malformed package.json is a repository defect an agent CAN fix, so it must
  // reach a verdict rather than park — `resolveUatGates` returns zero gates for it
  // and only the stage can turn that into a named failure.
  it('a malformed package.json -> a failing verdict naming the file, not a block', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'malformed', message: 'Unexpected token }' }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(stageBlock(store, id, 'uat')).toBeNull();
    const rows = listGateRuns(store, id);
    expect(rows.map((r) => r.gateName)).toEqual(['package.json (/wt/web)']);
    expect(rows[0]!.exitCode).toBe(1);
    expect(readFileSync(uatStage(store, id).artifactPath!, 'utf8')).toContain('Unexpected token }');
  });

  // `gate_runs` is the only append-only evidence table. A Stop that discarded the
  // gates that already finished would make work that really happened unrecoverable.
  it('persists the gates that finished before a Stop landed', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async () => ({
          kind: 'stopped',
          results: [{ name: 'test', exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() }],
        }),
      }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    const rows = listGateRuns(store, id);
    expect(rows.map((r) => r.gateName)).toEqual(['test (/wt/web)']);
    expect(rows[0]!.attempt).toBe(0);
    expect(uatStage(store, id).attempt).toBe(0);
    expect(readFileSync(uatStage(store, id).artifactPath!, 'utf8')).toContain('ok');
  });

  it('keeps the evidence of completed targets when a later one cannot be asked', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        }),
        probe: (cwd) =>
          cwd === '/wt/web'
            ? { kind: 'ok', scripts: { test: 'vitest' } }
            : { kind: 'io-error', message: 'EACCES' },
      }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    expect(listGateRuns(store, id).map((r) => r.gateName)).toEqual(['test (web)']);
    expect(listGateRuns(store, id)[0]!.attempt).toBe(0);
  });

  it('records the gate rows of a run that resolved to a block', async () => {
    // Every gate reported null: karst asked, and nothing answered. That is a park,
    // and the rows proving each gate said nothing must survive it.
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: null, output: 'nothing to run' })),
        }),
      }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(listGateRuns(store, id).map((r) => r.gateName).sort()).toEqual([
      'e2e (/wt/web)',
      'test (/wt/web)',
    ]);
    expect(listGateRuns(store, id).every((r) => r.exitCode === null)).toBe(true);
    expect(uatStage(store, id).artifactPath).not.toBeNull();
  });

  // A worktree whose repoPath is absent from the manifest is dropped by
  // `planUatTargets`, so "affected but unmapped" would otherwise be
  // indistinguishable from "nothing to test" — a silent absence.
  it('no target at all -> blocks with a reason naming the ticket worktrees', async () => {
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/unmapped', '/wt/unmapped', 'b', 'develop', 'inherited')",
      )
      .run(id);
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [] }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(res).toMatchObject({ reason: expect.stringContaining('/unmapped') });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
  });

  it('says so plainly when the ticket has no worktree at all', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [] }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(res).toMatchObject({ reason: expect.stringContaining('no worktree') });
  });

  // Two `repositories:` entries sharing a repoPath collapse to ONE target, so a
  // per-repository override on the second entry has no other chance to be honoured.
  it('honours the gate override of every manifest entry sharing one worktree', async () => {
    const ran: string[] = [];
    await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/mono',
        artifactDir,
        manifest: manifest(
          {},
          {
            uat: uatConfig({
              repositories: {
                web: { gates: [{ name: 'e2e-web', kind: 'command', command: 'npx', args: ['pw', 'web'] }] },
                admin: { gates: [{ name: 'e2e-admin', kind: 'command', command: 'npx', args: ['pw', 'admin'] }] },
              },
            }),
          },
        ),
      },
      deps({
        planTargets: async () => ({ kind: 'targets', targets: [{ repo: '/mono', path: '/wt/mono', names: ['web', 'admin'] }] }),
        runGates: async (gates) => {
          ran.push(...gates.map((g) => g.name));
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(ran.sort()).toEqual(['e2e-admin', 'e2e-web']);
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  it('asks one shared worktree the same question once, however many entries declare it', async () => {
    const ran: string[] = [];
    await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/mono',
        artifactDir,
        manifest: manifest(
          {},
          {
            uat: uatConfig({
              repositories: {
                web: { gates: [{ name: 'e2e', kind: 'script', script: 'e2e' }] },
                admin: { gates: [{ name: 'e2e', kind: 'script', script: 'e2e' }] },
              },
            }),
          },
        ),
      },
      deps({
        planTargets: async () => ({ kind: 'targets', targets: [{ repo: '/mono', path: '/wt/mono', names: ['web', 'admin'] }] }),
        runGates: async (gates) => {
          ran.push(...gates.map((g) => g.name));
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(ran).toEqual(['e2e']);
  });

  // Two entries in one worktree may declare the same gate NAME for different
  // commands, so a result must be attributed by position. Matching by name gives
  // both rows the first gate's identity, and the independent one disappears into
  // review's set — a spurious "asked no question review does not" warning.
  it('attributes each result to the gate that produced it, not to the first of that name', async () => {
    await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/mono',
        artifactDir,
        manifest: manifest(
          {},
          {
            uat: uatConfig({
              repositories: {
                web: { gates: [{ name: 'g', kind: 'script', script: 'test' }] },
                admin: { gates: [{ name: 'g', kind: 'command', command: 'npx', args: ['pw'] }] },
              },
            }),
          },
        ),
      },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [{ repo: '/mono', path: '/wt/mono', names: ['web', 'admin'] }],
        }),
      }),
    );
    // `npm test` duplicates review; `npx pw` does not, so the run asked something new.
    expect(readFileSync(uatStage(store, id).artifactPath!, 'utf8')).not.toContain(
      'asked no question review does not',
    );
  });

  it('threads one abort signal into every gate invocation, so Stop reaches a running gate', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, signal: controller.signal, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        }),
        runGates: async (gates, _cwd, opts) => {
          seen.push(opts?.signal);
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it('tells the gate runner which scripts the repository actually defines', async () => {
    let available: ((script: string) => boolean) | undefined;
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } }),
        runGates: async (gates, _cwd, opts) => {
          available = opts?.scriptsAvailable;
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(available?.('test')).toBe(true);
    expect(available?.('lint')).toBe(false);
  });

  it('leaves no gate rows behind when the transition throws', async () => {
    store.db.prepare('DELETE FROM stages WHERE ticket_id = ? AND stage_key = ?').run(id, 'uat');
    await expect(
      runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps()),
    ).rejects.toThrow(/has no stage 'uat'/);
    expect(listGateRuns(store, id)).toEqual([]);
  });
});
