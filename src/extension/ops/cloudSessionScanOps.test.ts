import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import type { GitResult, GitRunner } from '../../integrations/git.js';
import { listCloudSessionLinks } from '../../store/cloudSessionLinks.js';
import { makeCloudScanTick, makeCloudSessionScanner } from './cloudSessionScanOps.js';

const S1 = 'https://claude.ai/code/session_one';
const S2 = 'https://claude.ai/code/session_two';
const ok = (stdout: string): GitResult => ({ stdout, stderr: '', exitCode: 0 });
const bad: GitResult = { stdout: '', stderr: 'x', exitCode: 1 };

interface World {
  heads: Record<string, string>; // branch -> sha ('' = missing)
  logs: Record<string, string[]>; // `${path}|${range}` -> messages
  logCalls: string[][];
  revCalls: number;
}

function fakeGit(w: World): GitRunner {
  return async (args, cwd) => {
    if (args[0] === 'rev-parse') {
      w.revCalls++;
      const sha = w.heads[args[1]!];
      return sha ? ok(`${sha}\n`) : bad;
    }
    w.logCalls.push(args);
    const key = `${cwd}|${args.slice(1, -1).join(' ')}`;
    const msgs = w.logs[key];
    return msgs ? ok(msgs.map((m) => `${m}\n\x1e`).join('')) : bad;
  };
}

function setup() {
  const store = openStore(':memory:');
  store.db.prepare("INSERT INTO projects (id, slug) VALUES (1, 'p'), (2, 'q')").run();
  store.db
    .prepare("INSERT INTO tickets (id, project_id, key) VALUES (10, 1, 'P-10'), (11, 1, 'P-11'), (20, 2, 'Q-1')")
    .run();
  const wt = store.db.prepare(
    'INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)',
  );
  wt.run(10, 'api', '/w/10api', 'karst/p-10', 'main');
  wt.run(10, 'web', '/w/10web', 'karst/p-10', 'main');
  wt.run(11, 'api', '/w/11api', 'karst/p-11', null);
  wt.run(20, 'api', '/w/20api', 'karst/q-1', 'main');
  const world: World = {
    heads: { 'karst/p-10': 'a1', 'karst/p-11': 'b1', 'karst/q-1': 'c1' },
    logs: {
      '/w/10api|main..karst/p-10': [`feat\n\n${S1}`],
      '/w/10web|main..karst/p-10': ['feat web'],
      '/w/11api|-n 200 karst/p-11': [`other\n${S2}`],
      '/w/20api|main..karst/q-1': [`q ${S1}`],
    },
    logCalls: [],
    revCalls: 0,
  };
  return { store, world };
}

describe('makeCloudSessionScanner', () => {
  it('links sessions to the ticket whose branch carries them, scoped to the project', async () => {
    const { store, world } = setup();
    const sc = makeCloudSessionScanner({ store, git: fakeGit(world), fetchPrBody: async () => null });
    expect(await sc.scan(1)).toBe(true);
    const rows = listCloudSessionLinks(store, { projectId: 1 });
    expect(rows.map((r) => [r.url, r.ticketId, r.linkSource])).toEqual([
      [S1, 10, 'branch'],
      [S2, 11, 'branch'],
    ]);
    expect(listCloudSessionLinks(store, { projectId: 2 })).toEqual([]);
  });

  it('uses a bounded log when no base is recorded and a base..branch range otherwise', async () => {
    const { store, world } = setup();
    await makeCloudSessionScanner({ store, git: fakeGit(world), fetchPrBody: async () => null }).scan(1);
    expect(world.logCalls).toContainEqual(['log', 'main..karst/p-10', '--format=%B%x1e']);
    expect(world.logCalls).toContainEqual(['log', '-n', '200', 'karst/p-11', '--format=%B%x1e']);
  });

  it('only rescans a branch when its head SHA moves', async () => {
    const { store, world } = setup();
    const sc = makeCloudSessionScanner({ store, git: fakeGit(world), fetchPrBody: async () => null });
    await sc.scan(1);
    const first = world.logCalls.length;
    expect(await sc.scan(1)).toBe(false);
    expect(world.logCalls.length).toBe(first);
    world.heads['karst/p-11'] = 'b2';
    await sc.scan(1);
    expect(world.logCalls.length).toBe(first + 1);
  });

  it('a PR body carrying the URL wins and the body is cached per head', async () => {
    const { store, world } = setup();
    store.db
      .prepare("INSERT INTO prs (ticket_id, repo, number, url, status, head_ref) VALUES (11, 'api', 5, 'https://gh/pr/5', 'open', 'karst/p-11')")
      .run();
    let calls = 0;
    const sc = makeCloudSessionScanner({
      store,
      git: fakeGit(world),
      fetchPrBody: async (ref, cwd) => {
        calls++;
        expect([ref, cwd]).toEqual(['https://gh/pr/5', '/w/11api']);
        return `desc ${S1}`;
      },
    });
    await sc.scan(1);
    await sc.scan(1);
    expect(calls).toBe(1);
    const s1 = listCloudSessionLinks(store, { projectId: 1 }).find((r) => r.url === S1)!;
    expect([s1.ticketId, s1.linkSource]).toEqual([11, 'pr']);
  });

  it('refetches the PR body when the head moves, falls back to number, skips failures', async () => {
    const { store, world } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, status) VALUES (11, 'api', 7, 'open')").run();
    const refs: string[] = [];
    let body: string | null = null;
    const sc = makeCloudSessionScanner({
      store,
      git: fakeGit(world),
      fetchPrBody: async (ref) => {
        refs.push(ref);
        if (body === null) throw new Error('offline');
        return body;
      },
    });
    await sc.scan(1);
    expect(refs).toEqual(['7']);
    body = 'plain';
    await sc.scan(1);
    await sc.scan(1);
    expect(refs).toEqual(['7', '7']);
    world.heads['karst/p-11'] = 'b9';
    await sc.scan(1);
    expect(refs).toEqual(['7', '7', '7']);
  });

  it('ignores PRs without a worktree and branches git cannot read', async () => {
    const { store, world } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (10, 'gone', 1, 'u', 'open')").run();
    world.heads['karst/p-11'] = '';
    delete world.logs['/w/10web|main..karst/p-10'];
    let fetched = 0;
    const msgs: string[] = [];
    const sc = makeCloudSessionScanner({
      store,
      git: fakeGit(world),
      fetchPrBody: async () => (fetched++, null),
      debug: (m) => msgs.push(m),
    });
    await sc.scan(1);
    expect(fetched).toBe(0);
    expect(msgs).toEqual(['cloud-sessions: git log failed in /w/10web']);
    expect(listCloudSessionLinks(store, { projectId: 1 }).map((r) => r.url)).toEqual([S1]);
  });

  it('records an ambiguous session as unlinked', async () => {
    const { store, world } = setup();
    world.logs['/w/11api|-n 200 karst/p-11'] = [`x ${S1}`];
    const sc = makeCloudSessionScanner({ store, git: fakeGit(world), fetchPrBody: async () => null });
    await sc.scan(1);
    expect(listCloudSessionLinks(store, { projectId: 1 })).toMatchObject([
      { url: S1, ticketId: null, linkSource: null },
    ]);
  });
});

describe('makeCloudScanTick', () => {
  it('scans through gh for PR bodies and reports a change', async () => {
    const { store, world } = setup();
    store.db.prepare("INSERT INTO prs (ticket_id, repo, number, status) VALUES (11, 'api', 7, 'open')").run();
    const gh = async (args: string[]) => ({
      stdout: JSON.stringify({ body: S1 }),
      stderr: '',
      exitCode: 0,
      args,
    });
    const tick = makeCloudScanTick({ store, git: fakeGit(world), gh, debug: () => {}, logError: () => {} });
    expect(await tick(1)).toBe(true);
    expect(listCloudSessionLinks(store, { projectId: 1 }).find((r) => r.url === S1)?.ticketId).toBe(11);
  });
  it('swallows scan errors into logError', async () => {
    const { store } = setup();
    const errors: string[] = [];
    const git: GitRunner = async () => {
      throw new Error('boom');
    };
    const tick = makeCloudScanTick({
      store,
      git,
      gh: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      debug: () => {},
      logError: (m) => errors.push(m),
    });
    expect(await tick(1)).toBe(false);
    expect(errors).toEqual(['karst: cloud session scan failed']);
  });
});
