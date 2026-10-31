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
});
