import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { transition } from '../machine.js';
import { shipTicket } from './ship.js';
import { closeShipRun, listShipEvidence, openShipRepoStep, openShipRun } from '../../store/shipRuns.js';
import { getStage } from '../../store/stages.js';
import { nowIso } from '../../model/time.js';
import type { GhRunner } from '../../integrations/github.js';
import type { GitRunner } from '../../integrations/git.js';
import type { AgentAdapter } from '../../agent/adapter.js';

const REPO = '/repo/frontend';
const LIVE_URL = 'https://github.com/o/r/pull/18';

function ghWithOpenPr(): GhRunner {
  return async (a) => {
    if (a[1] === 'list') return { stdout: '[]', stderr: '', exitCode: 0 };
    if (a[1] === 'view') {
      return { stdout: JSON.stringify({ number: 18, url: LIVE_URL, state: 'OPEN', body: 'x' }), exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

/** git over a scripted worktree: `porcelain` is the dirty list, `ahead` the commits origin lacks. */
function scriptedGit(state: { porcelain: string; ahead: string }): { git: GitRunner; pushes: string[][] } {
  const pushes: string[][] = [];
  const git: GitRunner = async (args) => {
    if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
    if (args[0] === 'status') return { stdout: state.porcelain, stderr: '', exitCode: 0 };
    if (args[0] === 'rev-list' && args[1] === '--count') return { stdout: state.ahead, stderr: '', exitCode: 0 };
    if (args[0] === 'rev-parse') {
      return { stdout: args[2]?.startsWith('refs/remotes/') ? '0000001\n' : 'abc1234\n', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'push') pushes.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { git, pushes };
}

const adapter = {} as AgentAdapter;

describe('stranded-ship resume (@arch:SHIP-RESUME)', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'PROJ-1', title: 'add search' }).id;
    for (const s of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, s, { kind: 'passed' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, '/wt/fe', 'karst/x', 'develop', 'inherited')`,
      )
      .run(id, REPO);
    store.db
      .prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 18, ?, 'open')")
      .run(id, REPO, LIVE_URL);
  });

  /** A prior run the host death cut short, optionally with a push step. */
  function seedInterruptedRun(withPushStep: boolean): void {
    const prior = openShipRun(store, { ticketId: id, attempt: 1, startedAt: nowIso() });
    if (withPushStep) {
      openShipRepoStep(store, { shipRunId: prior.id, repo: REPO, step: 'push', detail: 'karst/x', startedAt: nowIso() });
    }
    closeShipRun(store, prior.id, 'interrupted', nowIso());
  }

  const lastRun = (): { status: string } => {
    const row = store.db.prepare('SELECT status FROM ship_runs ORDER BY id DESC LIMIT 1').get();
    return row as { status: string };
  };

  it('open push step + clean worktree + commits ahead: the resumed run pushes the committed HEAD', async () => {
    seedInterruptedRun(true);
    const { git, pushes } = scriptedGit({ porcelain: '', ahead: '2\n' });

    await shipTicket(store, { ticketId: id, resumeInterrupted: true }, ghWithOpenPr(), adapter, git);

    expect(pushes).toHaveLength(1);
    expect(lastRun().status).toBe('passed');
  });

  it('dirty worktree: nothing is committed or pushed, and the ship parks with the reason', async () => {
    seedInterruptedRun(true);
    const calls: string[][] = [];
    const inner = scriptedGit({ porcelain: ' M src/a.ts\n', ahead: '3\n' });
    const git: GitRunner = async (args, cwd, o) => {
      calls.push(args);
      return inner.git(args, cwd, o);
    };

    await expect(
      shipTicket(store, { ticketId: id, resumeInterrupted: true }, ghWithOpenPr(), adapter, git),
    ).rejects.toThrow('3 local commit(s) not on the PR; click Deliver');

    expect(calls.some((a) => a[0] === 'add' || a[0] === 'commit' || a[0] === 'push')).toBe(false);
    expect(lastRun().status).toBe('failed');
    expect(getStage(store, id, 'ship')?.verdict).toContain('click Deliver');
    const step = listShipEvidence(store, id).repos[REPO]?.steps.push;
    expect(step?.status).toBe('note');
    expect(step?.detail).toBe('3 local commit(s) not on the PR; click Deliver');
  });

  it('no prior push step: today\'s skip, nothing pushed (and no commits ahead: passes)', async () => {
    seedInterruptedRun(false);
    const { git, pushes } = scriptedGit({ porcelain: '', ahead: '0\n' });

    await shipTicket(store, { ticketId: id, resumeInterrupted: true }, ghWithOpenPr(), adapter, git);

    expect(pushes).toEqual([]);
    expect(lastRun().status).toBe('passed');
  });

  it('a run that skips every repo while commits wait never reads passed', async () => {
    const { git, pushes } = scriptedGit({ porcelain: '', ahead: '1\n' });

    await expect(shipTicket(store, { ticketId: id }, ghWithOpenPr(), adapter, git)).rejects.toThrow(
      '1 local commit(s) not on the PR; click Deliver',
    );

    expect(pushes).toEqual([]);
    expect(lastRun().status).not.toBe('passed');
  });
});
