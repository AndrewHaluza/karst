import { getPlacement } from '../store/placement.js';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { getTicketByKey } from '../store/tickets.js';
import { getStage } from '../store/stages.js';
import { stageBlock } from '../store/stageBlocks.js';
import { fixtureSpec } from './fixtures.js';
import { listGateRuns } from '../store/gateRuns.js';
import { listProcessRuns } from '../store/processRuns.js';
import { listStageRuns } from '../store/stageRuns.js';
import { parseFixtureFile } from './fixtureFile.js';
import { seedStore } from './seed.js';
import { getMergeCheck } from '../store/mergeChecks.js';
import { listFindings } from '../store/reviewFindings.js';

describe('seedStore', () => {
  it('seeds nothing for empty', () => {
    const store = openStore(':memory:');
    expect(seedStore(store, fixtureSpec('empty'))).toEqual([]);
  });
  it('seeds the blocked ticket at uat with its block', () => {
    const store = openStore(':memory:');
    const [id] = seedStore(store, fixtureSpec('blocked'));
    const t = getTicketByKey(store, 'FIX-BLOCKED');
    expect(t?.stageCurrent).toBe('uat');
    expect(stageBlock(store, id!, 'uat')?.kind).toBe('boot-failed');
  });
  it('seeds the launch draft with its repo selected', () => {
    const store = openStore(':memory:');
    seedStore(store, fixtureSpec('launch-draft'));
    const t = getTicketByKey(store, 'FIX-LAUNCH');
    expect(t?.stageCurrent).toBe('scope');
    expect(t?.selectedRepos).toEqual(['app']);
  });
  it('seeds the mid-stage ticket at impl', () => {
    const store = openStore(':memory:');
    seedStore(store, fixtureSpec('ticket-mid-stage'));
    const t = getTicketByKey(store, 'FIX-MID');
    expect(t?.stageCurrent).toBe('impl');
    expect(getStage(store, t!.id, 'impl')?.status).toBe('running');
  });
  it('seeds a stranded uat state: running stage, a run with no process or gate rows', () => {
    const store = openStore(':memory:');
    const spec = parseFixtureFile({
      tickets: [{
        key: 'STR-1', title: 's', stageCurrent: 'uat', worktree: true,
        stages: [{ stageKey: 'uat', status: 'running' }],
        rows: { stage_runs: [{ stageKey: 'uat', status: 'running' }] },
      }],
    });
    const [id] = seedStore(store, spec);
    expect(getStage(store, id!, 'uat')?.status).toBe('running');
    expect(listStageRuns(store, id!).map((r) => r.status)).toEqual(['running']);
    expect(listProcessRuns(store, id!)).toEqual([]);
    expect(listGateRuns(store, id!)).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?').get(id)).toEqual({ n: 1 });
  });
  it('seeds finished runs, linked process and gate rows, a recovery round and an archive', () => {
    const store = openStore(':memory:');
    const spec = parseFixtureFile({
      tickets: [{
        key: 'REC-1', title: 'r', stageCurrent: 'uat', archived: true,
        rows: {
          stage_runs: [{ stageKey: 'uat', status: 'finished', outcome: 'blocked' }],
          process_runs: [{ stageKey: 'uat', processId: 'tester', status: 'failed', stageRun: 0 }],
          gate_runs: [{ stageKey: 'uat', gateName: 'g', exitCode: 1, stageRun: 0 }],
          recovery_rounds: [{ sourceStage: 'uat', sourceProcessId: 'gates', triggerKind: 'gate-failure', triggerDetail: 'd' }],
        },
      }],
    });
    const [id] = seedStore(store, spec);
    const [run] = listStageRuns(store, id!);
    expect(run).toMatchObject({ status: 'finished', outcome: 'blocked' });
    expect(listProcessRuns(store, id!)[0]).toMatchObject({ status: 'failed', stageRunId: run!.id });
    expect(listGateRuns(store, id!)[0]).toMatchObject({ gateName: 'g', exitCode: 1, stageRunId: run!.id });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM recovery_rounds WHERE ticket_id = ?').get(id)).toEqual({ n: 1 });
    expect(getTicketByKey(store, 'REC-1')?.archivedAt).not.toBeNull();
  });
  it('seeds the brief and the repo binding instead of the fixed constants', () => {
    const store = openStore(':memory:');
    const spec = parseFixtureFile({
      tickets: [{
        key: 'EV-1', title: 'e', description: 'add a flag', stageCurrent: 'scope', worktree: true,
        repo: { repoPath: '/task', baseRef: 'trunk', worktreePath: '/task/wt/EV-1' },
      }],
    });
    const [id] = seedStore(store, spec);
    expect(getTicketByKey(store, 'EV-1')?.description).toBe('add a flag');
    expect(store.db.prepare('SELECT repo, path, branch, base_ref FROM worktrees WHERE ticket_id = ?').get(id))
      .toEqual({ repo: '/task', path: '/task/wt/EV-1', branch: 'karst/EV-1', base_ref: 'trunk' });
  });
  it('keeps the old defaults without a binding', () => {
    const store = openStore(':memory:');
    const [id] = seedStore(store, parseFixtureFile({ tickets: [{ key: 'D-1', title: 'd', stageCurrent: 'uat', worktree: true }] }));
    expect(store.db.prepare('SELECT repo, path, base_ref FROM worktrees WHERE ticket_id = ?').get(id))
      .toEqual({ repo: '/fixture/repo', path: '/fixture/repo/.karst/worktrees/D-1', base_ref: 'main' });
  });
  it('binds a default worktree to the given manifest repo path, so stages map it to a repository', () => {
    const store = openStore(':memory:');
    const [id] = seedStore(store, parseFixtureFile({ tickets: [{ key: 'D-2', title: 'd', stageCurrent: 'review', worktree: true }] }), { repoPath: '/ws/repo' });
    const row = store.db.prepare('SELECT repo, path, base_ref FROM worktrees WHERE ticket_id = ?').get(id) as { repo: string; path: string; base_ref: string };
    expect(row).toEqual({ repo: '/ws/repo', path: '/ws/repo/.karst/worktrees/D-2', base_ref: 'main' });
  });
});

describe('seedStore servers', () => {
  const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'karst-seed-servers-'));

  it('writes a running row from the injected spawner and a failed row with its reason', () => {
    const repoPath = tmpRoot();
    const store = openStore(':memory:');
    const spec = parseFixtureFile({
      tickets: [{ key: 'T-S', title: 's', stageCurrent: 'impl' }],
      servers: [
        { ticket: 'T-S', service: 'api', status: 'running', port: 4000 },
        { ticket: 'T-S', service: 'web', status: 'failed', port: 3000, lastError: 'Port 3000 in use by pid 4123' },
      ],
    });
    const asked: number[] = [];
    const [id] = seedStore(store, spec, { repoPath, spawnServer: (port) => { asked.push(port); return 4321; } });
    expect(asked).toEqual([4000]);
    expect(store.db.prepare('SELECT repo, host, port, pid, status, last_error, log_path, cwd FROM servers WHERE ticket_id = ? ORDER BY port DESC').all(id))
      .toEqual([
        { repo: 'api', host: 'localhost', port: 4000, pid: 4321, status: 'running', last_error: null, log_path: join(repoPath, '.karst', 'logs', 'api.log'), cwd: repoPath },
        { repo: 'web', host: 'localhost', port: 3000, pid: null, status: 'failed', last_error: 'Port 3000 in use by pid 4123', log_path: join(repoPath, '.karst', 'logs', 'web.log'), cwd: repoPath },
      ]);
  });

  it('writes a log of logBytes bytes at the row log path and none without it', () => {
    const repoPath = tmpRoot();
    const store = openStore(':memory:');
    const spec = parseFixtureFile({
      tickets: [{ key: 'T-L', title: 'l', stageCurrent: 'impl' }],
      servers: [
        { ticket: 'T-L', service: 'worker', status: 'running', port: 4100, logBytes: 4096 },
        { ticket: 'T-L', service: 'api', status: 'running', port: 4000 },
      ],
    });
    seedStore(store, spec, { repoPath, spawnServer: () => 11 });
    expect(statSync(join(repoPath, '.karst', 'logs', 'worker.log')).size).toBeGreaterThanOrEqual(4096);
    expect(existsSync(join(repoPath, '.karst', 'logs', 'api.log'))).toBe(false);
  });

  it('puts a worktree ticket log in its worktree', () => {
    const repoPath = tmpRoot();
    const store = openStore(':memory:');
    const spec = parseFixtureFile({
      tickets: [{ key: 'T-W', title: 'w', stageCurrent: 'impl', worktree: true }],
      servers: [{ ticket: 'T-W', service: 'api', status: 'running', port: 4000 }],
    });
    const [id] = seedStore(store, spec, { repoPath, spawnServer: () => 12 });
    const cwd = join(repoPath, '.karst', 'worktrees', 'T-W');
    expect(store.db.prepare('SELECT cwd, log_path FROM servers WHERE ticket_id = ?').get(id)).toEqual({
      cwd, log_path: join(cwd, '.karst', 'logs', 'api.log'),
    });
  });
});

describe('seedStore engine rows', () => {
  it('seeds a PR with its merge block, a merge check and review findings through the store APIs', () => {
    const store = openStore(':memory:');
    const spec = parseFixtureFile({
      tickets: [{
        key: 'T-G', title: 'g', stageCurrent: 'ship',
        rows: {
          prs: [{ repo: 'app', number: 5, url: 'https://x/pull/5', status: 'open', baseRef: 'develop', mergeBlock: 'dirty' }],
          merge_checks: [{ repo: 'app', state: 'conflicted', files: ['a.ts'], headSha: 'h', baseSha: 'b', baseRef: 'develop' }],
          review_findings: [{ attempt: 1, severity: 'high', repo: 'app', file: 'a.ts', line: 4, title: 't', detail: 'd' }],
        },
      }],
    });
    const [id] = seedStore(store, spec);
    expect(store.db.prepare('SELECT number, status, base_ref, merge_block FROM prs WHERE ticket_id = ?').get(id))
      .toEqual({ number: 5, status: 'open', base_ref: 'develop', merge_block: 'dirty' });
    expect(getMergeCheck(store, id!, 'app')).toMatchObject({ state: 'conflicted', files: ['a.ts'], headSha: 'h', baseSha: 'b' });
    expect(listFindings(store, id!)).toHaveLength(1);
  });

  it('names the worktree row after the manifest repo when worktreeRepo is set', () => {
    const store = openStore(':memory:');
    const [id] = seedStore(store, parseFixtureFile({ tickets: [{ key: 'T-W', title: 'w', stageCurrent: 'ship', worktree: true, worktreeRepo: 'app' }] }));
    expect(store.db.prepare('SELECT repo FROM worktrees WHERE ticket_id = ?').get(id)).toEqual({ repo: 'app' });
  });

  it('records a host placement, and none when the seed names none', () => {
    const store = openStore(':memory:');
    const spec = parseFixtureFile({ tickets: [
      { key: 'T-P', title: 'p', stageCurrent: 'ship', placement: 'host' },
      { key: 'T-N', title: 'n', stageCurrent: 'ship' },
    ] });
    const [placed, bare] = seedStore(store, spec);
    expect(getPlacement(store, placed!)).toEqual({ backend: 'host', core: null, sandboxName: null, reason: null });
    expect(getPlacement(store, bare!)).toBeNull();
  });
});

