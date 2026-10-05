import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, getPlanningSession, linkPlanningTicket, setPlanningSessionStatus } from '../../store/planningSessions.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { repo } from '../../manifest/fixtures.js';
import type { CreateTerminalOpts, SessionTerminal, TerminalHost } from '../../ui/session.js';
import { createPlanningOps, type PlanningOpsDeps } from './planningOps.js';

interface Recorded {
  opts: CreateTerminalOpts;
  shown: number;
  disposed: boolean;
  close?: (exitCode?: number) => void;
}

function fakeHost(): { host: TerminalHost; created: Recorded[] } {
  const created: Recorded[] = [];
  const host: TerminalHost = {
    createTerminal(opts): SessionTerminal {
      const rec: Recorded = { opts, shown: 0, disposed: false };
      created.push(rec);
      return {
        show: () => void rec.shown++,
        sendText: () => undefined,
        dispose: () => {
          rec.disposed = true;
          rec.close?.();
        },
        onDidClose: (h) => void (rec.close = h),
      };
    },
  };
  return { host, created };
}

describe('planning ops', () => {
  let store: Store;
  let projectId: number;
  let created: Recorded[];
  let deps: PlanningOpsDeps;
  const messages: string[] = [];
  let changes = 0;
  let scratch: string;
  beforeEach(() => {
    store = openStore(':memory:');
    scratch = mkdtempSync(join(tmpdir(), 'karst-plan-'));
    projectId = upsertProject(store, { slug: 'p' }).id;
    const fake = fakeHost();
    created = fake.created;
    deps = {
      store,
      projectId: () => projectId,
      manifest: () => ({
        baselineBranch: 'main',
        repositories: { api: repo({ repoPath: '/src/api' }), web: repo({ repoPath: '/src/web' }) },
      }),
      scratchDir: (id) => join(scratch, String(id)),
      defaultAgent: () => ({ provider: 'claude', model: 'opus' }),
      host: fake.host,
      cli: () => ({ cliEntry: '/dist/cli/main.js', dbPath: '/db/karst.db', manifestPath: '/src/karst.yml' }),
      onChange: () => void changes++,
      notify: { info: (m) => void messages.push(m), warn: (m) => void messages.push(m), error: async () => undefined },
    };
  });
  afterEach(() => {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('creates a session and launches a read-only agent across every repo', () => {
    const ops = createPlanningOps(deps);
    const session = ops.create('Auth rework')!;
    expect(session).toMatchObject({ title: 'Auth rework', core: 'claude', model: 'opus', status: 'active' });
    const { opts } = created[0]!;
    expect(opts.cwd).toBe(join(scratch, String(session.id)));
    expect(existsSync(opts.cwd)).toBe(true);
    expect(opts.name).toBe(`Karst plan #${session.id}: Auth rework`);
    expect(opts.shellArgs).toEqual(expect.arrayContaining(['--disallowedTools', 'Edit', '--add-dir', '/src/api', '/src/web']));
    expect(opts.shellArgs.join(' ')).toContain(`draft create --session ${session.id}`);
    expect(opts.env).toMatchObject({ KARST_PLANNING_SESSION: String(session.id), KARST_DB: '/db/karst.db' });
    expect(opts.env).not.toHaveProperty('KARST_TICKET_ID');
  });

  it('focuses the live terminal on open instead of launching a second one', () => {
    const ops = createPlanningOps(deps);
    const s = ops.create('t')!;
    ops.open(s.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.shown).toBe(2);
  });

  it('relaunches on open after the terminal closed', () => {
    const ops = createPlanningOps(deps);
    const s = ops.create('t')!;
    created[0]!.close?.(0);
    ops.open(s.id);
    expect(created).toHaveLength(2);
  });

  it('archives a session and disposes its terminal', () => {
    const ops = createPlanningOps(deps);
    const s = ops.create('t')!;
    changes = 0;
    ops.archive(s.id);
    expect(changes).toBeGreaterThan(0);
    expect(ops.isLive(s.id)).toBe(false);
    expect(created[0]!.disposed).toBe(true);
    expect(getPlanningSession(store, s.id)!.status).toBe('archived');
  });

  it('lets a sandboxing core write the registry directory (codex)', () => {
    const ops = createPlanningOps({ ...deps, defaultAgent: () => ({ provider: 'codex', model: null }) });
    ops.create('t');
    expect(created[0]!.opts.shellArgs).toContain('sandbox_workspace_write.writable_roots=["/db"]');
  });

  it('refuses without a project and warns instead of throwing', () => {
    const ops = createPlanningOps({ ...deps, projectId: () => undefined });
    expect(ops.create('t')).toBeUndefined();
    expect(messages.at(-1)).toMatch(/project/i);
    expect(created).toHaveLength(0);
  });

  it('lists sessions with their linked ticket count', () => {
    const ops = createPlanningOps(deps);
    const s = ops.create('t')!;
    linkPlanningTicket(store, s.id, createTicketFlow(store, { key: 'T-1', title: 'x' }).id);
    expect(ops.list()).toEqual([expect.objectContaining({ id: s.id, ticketCount: 1, live: true, status: 'filed' })]);
  });

  it('warns and launches nothing without a manifest', () => {
    const ops = createPlanningOps({ ...deps, manifest: () => undefined });
    const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
    ops.open(s.id);
    expect(created).toHaveLength(0);
    expect(messages.at(-1)).toMatch(/manifest/i);
  });

  it('does not leave an orphan session when create cannot launch', () => {
    const ops = createPlanningOps({ ...deps, manifest: () => undefined });
    expect(ops.create('t')).toBeUndefined();
    expect(ops.list()).toEqual([]);
  });

  it('warns instead of throwing when the terminal cannot be created, and drops the new session', () => {
    const debugs: string[] = [];
    const ops = createPlanningOps({
      ...deps,
      debug: (m) => void debugs.push(m),
      host: { createTerminal: () => { throw new Error('pty gone'); } },
    });
    expect(ops.create('t')).toBeUndefined();
    expect(messages.at(-1)).toMatch(/could not start/i);
    expect(debugs.some((m) => m.includes('pty gone'))).toBe(true);
    expect(ops.list()).toEqual([]);
  });

  it('keeps an existing session when a reopen fails to launch', () => {
    const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
    const ops = createPlanningOps({ ...deps, scratchDir: () => '/dev/null/nope' });
    expect(() => ops.open(s.id)).not.toThrow();
    expect(messages.at(-1)).toMatch(/could not start/i);
    expect(getPlanningSession(store, s.id)!.status).toBe('active');
  });

  it('refuses to open an archived or unknown session', () => {
    const ops = createPlanningOps(deps);
    const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
    setPlanningSessionStatus(store, s.id, 'archived');
    ops.open(s.id);
    ops.open(9999);
    expect(created).toHaveLength(0);
    expect(messages.filter((m) => /no longer exists/.test(m))).toHaveLength(2);
  });

  it('notifies a change when the planning terminal closes', () => {
    const ops = createPlanningOps(deps);
    const s = ops.create('t')!;
    changes = 0;
    created[0]!.close?.(0);
    expect(changes).toBe(1);
    expect(ops.isLive(s.id)).toBe(false);
  });

  it('unarchives to filed when it produced tickets, else to active', () => {
    const ops = createPlanningOps(deps);
    const a = createPlanningSession(store, { projectId, title: 'a', core: 'claude', model: null });
    const b = createPlanningSession(store, { projectId, title: 'b', core: 'claude', model: null });
    linkPlanningTicket(store, b.id, createTicketFlow(store, { key: 'T-1', title: 'x' }).id);
    ops.archive(a.id);
    ops.archive(b.id);
    changes = 0;
    ops.unarchive(a.id);
    ops.unarchive(b.id);
    expect(getPlanningSession(store, a.id)!.status).toBe('active');
    expect(getPlanningSession(store, b.id)!.status).toBe('filed');
    expect(changes).toBe(2);
    ops.unarchive(9999);
    expect(messages.at(-1)).toMatch(/no longer exists/);
  });

  describe('adopt (window reload)', () => {
    function revived(): { terminal: SessionTerminal; rec: Recorded } {
      const rec: Recorded = { opts: {} as CreateTerminalOpts, shown: 0, disposed: false };
      return {
        rec,
        terminal: {
          show: () => void rec.shown++,
          sendText: () => undefined,
          dispose: () => { rec.disposed = true; rec.close?.(); },
          onDidClose: (h) => void (rec.close = h),
        },
      };
    }

    it('re-registers a surviving terminal by env, so open focuses it and archive disposes it', () => {
      const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
      const ops = createPlanningOps(deps);
      const r = revived();
      ops.adopt([{ name: 'claude', env: { KARST_PLANNING_SESSION: String(s.id) }, terminal: r.terminal }]);
      expect(ops.isLive(s.id)).toBe(true);
      ops.open(s.id);
      expect(created).toHaveLength(0);
      expect(r.rec.shown).toBe(1);
      ops.archive(s.id);
      expect(r.rec.disposed).toBe(true);
    });

    it('falls back to the scratch cwd, then the tab name, when the env is gone', () => {
      const a = createPlanningSession(store, { projectId, title: 'a', core: 'claude', model: null });
      const b = createPlanningSession(store, { projectId, title: 'b', core: 'claude', model: null });
      const ops = createPlanningOps(deps);
      ops.adopt([
        { name: 'renamed by the agent', cwd: join(scratch, String(a.id)), terminal: revived().terminal },
        { name: `Karst plan #${b.id}: b`, terminal: revived().terminal },
      ]);
      expect(ops.isLive(a.id)).toBe(true);
      expect(ops.isLive(b.id)).toBe(true);
    });

    it('ignores archived, unknown, other-project, exited and foreign terminals', () => {
      const archived = createPlanningSession(store, { projectId, title: 'x', core: 'claude', model: null });
      setPlanningSessionStatus(store, archived.id, 'archived');
      const other = upsertProject(store, { slug: 'q' }).id;
      const foreign = createPlanningSession(store, { projectId: other, title: 'y', core: 'claude', model: null });
      const dead = createPlanningSession(store, { projectId, title: 'z', core: 'claude', model: null });
      const ops = createPlanningOps(deps);
      ops.adopt([
        { name: 'a', env: { KARST_PLANNING_SESSION: String(archived.id) }, terminal: revived().terminal },
        { name: 'b', env: { KARST_PLANNING_SESSION: '9999' }, terminal: revived().terminal },
        { name: 'c', env: { KARST_PLANNING_SESSION: String(foreign.id) }, terminal: revived().terminal },
        { name: 'd', env: { KARST_PLANNING_SESSION: String(dead.id) }, exited: true, terminal: revived().terminal },
        { name: 'zsh', env: { KARST_TICKET_ID: '3' }, terminal: revived().terminal },
      ]);
      expect([archived.id, foreign.id, dead.id].some((id) => ops.isLive(id))).toBe(false);
    });

    it('forgets an adopted terminal when it closes', () => {
      const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
      const ops = createPlanningOps(deps);
      const r = revived();
      ops.adopt([{ name: 'n', env: { KARST_PLANNING_SESSION: String(s.id) }, terminal: r.terminal }]);
      changes = 0;
      r.rec.close?.(0);
      expect(ops.isLive(s.id)).toBe(false);
      expect(changes).toBe(1);
    });
  });
});
