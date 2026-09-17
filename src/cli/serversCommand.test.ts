import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listServersByTicket } from '../store/dashboard.js';
import type { Manifest } from '../manifest/types.js';
import {
  composeServersPrefix,
  parseServersArgs,
  renderServersInstruction,
  resolveHotRepos,
  runServersCommand,
  scrubKarstSessionEnv,
} from './serversCommand.js';
import { SERVERS_VIA_CLI_RULE } from '../agent/promptText.js';

const manifest = (repos: string[]): Manifest =>
  ({
    repositories: Object.fromEntries(repos.map((r) => [r, { repoPath: `/repos/${r}` }])),
  }) as unknown as Manifest;

const seedWorktree = (store: Store, ticketId: number, repoPath: string, path: string): void => {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path) VALUES (?, ?, ?)')
    .run(ticketId, repoPath, path);
};

describe('parseServersArgs', () => {
  it('rejects a missing or unknown action', () => {
    expect(() => parseServersArgs(['servers'])).toThrow(
      "karst servers: want 'list', 'spin', 'restart' or 'stop' (got '')",
    );
    expect(() => parseServersArgs(['servers', 'frobnicate'])).toThrow(
      "karst servers: want 'list', 'spin', 'restart' or 'stop' (got 'frobnicate')",
    );
  });

  it('splits and trims --repos', () => {
    const parsed = parseServersArgs(['servers', 'spin', '--repos', ' a , b ']);
    expect(parsed.repos).toEqual(['a', 'b']);
  });

  it('rejects --repos on list and stop', () => {
    expect(() => parseServersArgs(['servers', 'list', '--repos', 'a'])).toThrow(
      "karst servers: --repos is only valid for 'spin' and 'restart'",
    );
    expect(() => parseServersArgs(['servers', 'stop', '--repos', 'a'])).toThrow(
      "karst servers: --repos is only valid for 'spin' and 'restart'",
    );
  });
});

describe('resolveHotRepos', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'K-1', title: 'demo' }).id;
  });

  afterEach(() => store.close());

  it('prefers an explicit --repos list over worktree rows', () => {
    seedWorktree(store, id, '/repos/a', '/wt/a');
    expect(resolveHotRepos(store, manifest(['a', 'b']), id, ['b'], '/k.yml')).toEqual(['b']);
  });

  it("resolves the ticket's distinct worktree repo PATHS back to repository names", () => {
    seedWorktree(store, id, '/repos/a', '/wt/a');
    seedWorktree(store, id, '/repos/a', '/wt/a2');
    seedWorktree(store, id, '/repos/b', '/wt/b');
    expect(resolveHotRepos(store, manifest(['a', 'b']), id, [], '/k.yml')).toEqual(['a', 'b']);
  });

  it('maps a repoPath shared by several repositories to every name that declares it', () => {
    const shared = {
      repositories: {
        'api-fe': { repoPath: '/repos/app' },
        'api-be': { repoPath: '/repos/app' },
      },
    } as unknown as Manifest;
    seedWorktree(store, id, '/repos/app', '/wt/app');
    expect(resolveHotRepos(store, shared, id, [], '/k.yml')).toEqual(['api-fe', 'api-be']);
  });

  it('falls back to all manifest repositories when the ticket has no worktree rows', () => {
    expect(resolveHotRepos(store, manifest(['a', 'b']), id, [], '/k.yml')).toEqual(['a', 'b']);
  });

  it('throws for a repo the manifest does not declare, and the message names it', () => {
    expect(() => resolveHotRepos(store, manifest(['a', 'b']), id, ['c'], '/k.yml')).toThrow(
      /'c' is not a repository/,
    );
    expect(() => resolveHotRepos(store, manifest(['a', 'b']), id, ['c'], '/k.yml')).toThrow(
      /have: a, b/,
    );
  });
});

describe('runServersCommand', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'K-1', title: 'demo' }).id;
  });

  afterEach(() => store.close());

  it('list returns the rows listServersByTicket returns', async () => {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, kind)
         VALUES (?, 'api', 'localhost', 4100, 1234, 'running', '/tmp/api.log', 'service')`,
      )
      .run(id);
    const out = JSON.parse(
      await runServersCommand(store, manifest(['api']), id, ['servers', 'list'], '/k.yml'),
    );
    expect(out.ok).toBe(true);
    expect(out.servers).toEqual(listServersByTicket(store, id));
  });

  it('throws for spin when manifest is undefined', async () => {
    await expect(
      runServersCommand(store, undefined, id, ['servers', 'spin'], undefined),
    ).rejects.toThrow("karst servers: 'spin' needs --manifest <karst.yml>");
  });
});

describe('composeServersPrefix', () => {
  it('composes flags-first with every path quoted', () => {
    expect(composeServersPrefix('/ext/dist/cli/main.js', '/App Support/karst.db', '/repo/.karst/karst.yml', 'FIX-1-X'))
      .toBe('node "/ext/dist/cli/main.js" --db "/App Support/karst.db" --manifest "/repo/.karst/karst.yml" --ticket "FIX-1-X"');
  });
});

describe('renderServersInstruction', () => {
  it('states the shared rule verbatim and all four commands', () => {
    const text = renderServersInstruction('node "cli" --db "db" --manifest "m" --ticket "K"');
    expect(text).toContain(SERVERS_VIA_CLI_RULE);
    expect(text.startsWith('## Services')).toBe(true);
    for (const action of ['list', 'spin', 'restart', 'stop']) {
      expect(text).toContain(`node "cli" --db "db" --manifest "m" --ticket "K" servers ${action}`);
    }
  });

  it('never tells the session to run a service by hand', () => {
    const text = renderServersInstruction('node "cli" --db "db" --manifest "m" --ticket "K"');
    expect(text).toMatch(/Never start, restart or stop a ticket service by hand/);
  });
});

describe('scrubKarstSessionEnv', () => {
  it('strips every KARST_* session variable and leaves the rest untouched', () => {
    const env: NodeJS.ProcessEnv = {
      KARST_GRAPH_CAPABILITY: 'cap',
      KARST_GRAPH_CALLBACK_TOKEN: 'tok',
      KARST_GRAPH_CALLBACK_URL: 'http://127.0.0.1:1/cb',
      KARST_TICKET_ID: '7',
      PATH: '/bin',
      HOME: '/root',
    };
    scrubKarstSessionEnv(env);
    expect(env).toEqual({ PATH: '/bin', HOME: '/root' });
  });
});
