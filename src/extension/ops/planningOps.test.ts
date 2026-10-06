import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, getPlanningSession, linkPlanningTicket, setPlanningSessionStatus } from '../../store/planningSessions.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { repo } from '../../manifest/fixtures.js';
import type { CreateTerminalOpts, SessionTerminal, TerminalHost } from '../../ui/session.js';
import { KARST_TERMINAL_ICON_ID } from '../../ui/terminalNaming.js';
import { hashInstructions } from '../../agent/instructions.js';
import { createPlanningOps, planningSessionIdOf, type PlanningOpsDeps } from './planningOps.js';

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
      cliEntry: () => '/dist/cli/main.js',
      onChange: () => void changes++,
      notify: { info: (m) => void messages.push(m), warn: (m) => void messages.push(m), error: async () => undefined },
    };
  });
  afterEach(() => {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('creates a session and launches a read-only agent across every repo', async () => {
    const ops = createPlanningOps(deps);
    const session = (await ops.create('Auth rework'))!;
    expect(session).toMatchObject({ title: 'Auth rework', core: 'claude', model: 'opus', status: 'active' });
    const { opts } = created[0]!;
    expect(opts.cwd).toBe(join(scratch, String(session.id)));
    expect(existsSync(opts.cwd)).toBe(true);
    expect(opts.name).toBe(`P${session.id} Auth rework`);
    expect(opts.iconPath).toBe(KARST_TERMINAL_ICON_ID);
    expect(opts.shellArgs).toEqual(expect.arrayContaining(['--disallowedTools', 'Edit', '--add-dir', '/src/api', '/src/web']));
    // The standing rules ride the instruction FILE through claude's own
    // system-prompt channel — never as inline kickoff prose.
    const instructionsPath = opts.env!.KARST_INSTRUCTIONS!;
    expect(instructionsPath).toBe(join(opts.cwd, 'karst-instructions.md'));
    expect(readFileSync(instructionsPath, 'utf8')).toContain('draft propose');
    expect(opts.shellArgs).toContain('--append-system-prompt-file');
    expect(opts.shellArgs).toContain(instructionsPath);
    expect(opts.shellArgs.join(' ')).not.toContain('You are in a karst PLANNING session');
    expect(opts.env).toEqual(expect.objectContaining({
      KARST_PLANNING_SESSION: String(session.id),
      KARST_CLI: '/dist/cli/main.js',
      KARST_INSTRUCTIONS: instructionsPath,
      KARST_OUTBOX: join(opts.cwd, 'outbox'),
    }));
    expect(existsSync(join(opts.cwd, 'outbox'))).toBe(true);
    for (const key of ['KARST_TICKET_ID', 'KARST_DB', 'KARST_MANIFEST']) expect(opts.env).not.toHaveProperty(key);
  });

  it('focuses the live terminal on open instead of launching a second one', async () => {
    const ops = createPlanningOps(deps);
    const s = (await ops.create('t'))!;
    await ops.open(s.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.shown).toBe(2);
  });

  it('relaunches on open after the terminal closed', async () => {
    const ops = createPlanningOps(deps);
    const s = (await ops.create('t'))!;
    created[0]!.close?.(0);
    await ops.open(s.id);
    expect(created).toHaveLength(2);
  });

  it('archives a session and disposes its terminal', async () => {
    const ops = createPlanningOps(deps);
    const s = (await ops.create('t'))!;
    changes = 0;
    ops.archive(s.id);
    expect(changes).toBeGreaterThan(0);
    expect(ops.isLive(s.id)).toBe(false);
    expect(created[0]!.disposed).toBe(true);
    expect(getPlanningSession(store, s.id)!.status).toBe('archived');
  });

  it('gives a sandboxing core (codex) no writable root beyond the scratch cwd', async () => {
    const ops = createPlanningOps({ ...deps, defaultAgent: () => ({ provider: 'codex', model: null }) });
    await ops.create('t');
    expect(created[0]!.opts.shellArgs).toContain('sandbox_workspace_write.writable_roots=[]');
  });

  it.each(['claude', 'codex', 'opencode', 'antigravity'] as const)(
    'never puts the registry or manifest path in a %s planning launch',
    async (provider) => {
      const ops = createPlanningOps({
        ...deps,
        defaultAgent: () => ({ provider, model: null }),
        confirmUnsafeCore: async () => true,
      });
      await ops.create('t');
      const { opts } = created[0]!;
      const launch = JSON.stringify({ args: opts.shellArgs, env: opts.env });
      expect(launch).not.toMatch(/KARST_DB|KARST_MANIFEST|karst\.db|--db|--manifest/);
    },
  );

  it.each(['claude', 'codex', 'opencode', 'antigravity'] as const)(
    'delivers the planning instructions through %s own channel, never inline',
    async (provider) => {
      const ops = createPlanningOps({
        ...deps,
        defaultAgent: () => ({ provider, model: null }),
        confirmUnsafeCore: async () => true,
      });
      await ops.create('t');
      const { opts } = created[0]!;
      const path = opts.env!.KARST_INSTRUCTIONS!;
      expect(existsSync(path), `${provider} writes the instructions file`).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('You are in a karst PLANNING session');
      const argv = opts.shellArgs.join(' ');
      expect(argv, `${provider} must not inline the body`).not.toContain(
        'You are in a karst PLANNING session',
      );
      if (provider === 'claude') {
        expect(opts.shellArgs).toContain('--append-system-prompt-file');
        expect(opts.shellArgs).toContain(path);
      } else {
        expect(argv, `${provider} pointer names KARST_INSTRUCTIONS`).toContain('KARST_INSTRUCTIONS');
      }
    },
  );

  // Item 8: a planning session has no process-run row, so its instruction-layer
  // telemetry is logged at debug level only — size, digest and channel, never
  // the body.
  it('logs the instruction layer size, digest and channel at debug level, never the body', async () => {
    const debugs: string[] = [];
    const ops = createPlanningOps({ ...deps, debug: (m) => void debugs.push(m) });
    const s = (await ops.create('t'))!;
    const path = created[0]!.opts.env!.KARST_INSTRUCTIONS!;
    const body = readFileSync(path, 'utf8').replace(/\n$/, '');
    const line = debugs.find((m) => m.includes(`launch ${s.id}:`));
    expect(line, 'the launch debug line is emitted').toBeDefined();
    expect(line).toContain(`${body.length}c`);
    expect(line).toContain(hashInstructions(body));
    expect(line).toContain('native-file');
    expect(line).not.toContain('You are in a karst PLANNING session');
  });

  describe('a core that cannot block edits (agy)', () => {
    const agy = (): PlanningOpsDeps['defaultAgent'] => () => ({ provider: 'antigravity', model: null });

    it('asks before every launch and logs the acknowledgement', async () => {
      const asked: string[] = [];
      const debugs: string[] = [];
      const ops = createPlanningOps({
        ...deps,
        defaultAgent: agy(),
        debug: (m) => void debugs.push(m),
        confirmUnsafeCore: async (core) => { asked.push(core); return true; },
      });
      const s = (await ops.create('t'))!;
      created[0]!.close?.(0);
      await ops.open(s.id);
      expect(asked).toEqual(['antigravity', 'antigravity']);
      expect(created).toHaveLength(2);
      expect(debugs.filter((m) => /acknowledged/.test(m))).toHaveLength(2);
    });

    it('launches nothing and drops the new session when declined (or when nobody can ask)', async () => {
      for (const confirmUnsafeCore of [async () => false, undefined]) {
        const ops = createPlanningOps({
          ...deps,
          defaultAgent: agy(),
          ...(confirmUnsafeCore ? { confirmUnsafeCore } : {}),
        });
        expect(await ops.create('t')).toBeUndefined();
        expect(ops.list()).toEqual([]);
      }
      expect(created).toHaveLength(0);
    });

    it('keeps an existing session when a reopen is declined', async () => {
      const s = createPlanningSession(store, { projectId, title: 't', core: 'antigravity', model: null });
      const ops = createPlanningOps({ ...deps, confirmUnsafeCore: async () => false });
      await ops.open(s.id);
      expect(created).toHaveLength(0);
      expect(getPlanningSession(store, s.id)!.status).toBe('active');
    });

    it('never asks for a core that blocks edits', async () => {
      let asked = 0;
      const ops = createPlanningOps({ ...deps, confirmUnsafeCore: async () => { asked++; return false; } });
      await ops.create('t');
      expect(asked).toBe(0);
      expect(created).toHaveLength(1);
    });
  });

  it('refuses without a project and warns instead of throwing', async () => {
    const ops = createPlanningOps({ ...deps, projectId: () => undefined });
    expect(await ops.create('t')).toBeUndefined();
    expect(messages.at(-1)).toMatch(/project/i);
    expect(created).toHaveLength(0);
  });

  it('lists sessions with their linked ticket count', async () => {
    const ops = createPlanningOps(deps);
    const s = (await ops.create('t'))!;
    linkPlanningTicket(store, s.id, createTicketFlow(store, { key: 'T-1', title: 'x' }).id);
    expect(ops.list()).toEqual([expect.objectContaining({ id: s.id, ticketCount: 1, live: true, status: 'filed' })]);
  });

  it('warns and launches nothing without a manifest', async () => {
    const ops = createPlanningOps({ ...deps, manifest: () => undefined });
    const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
    await ops.open(s.id);
    expect(created).toHaveLength(0);
    expect(messages.at(-1)).toMatch(/manifest/i);
  });

  it('does not leave an orphan session when create cannot launch', async () => {
    const ops = createPlanningOps({ ...deps, manifest: () => undefined });
    expect(await ops.create('t')).toBeUndefined();
    expect(ops.list()).toEqual([]);
  });

  it('warns instead of throwing when the terminal cannot be created, and drops the new session', async () => {
    const debugs: string[] = [];
    const ops = createPlanningOps({
      ...deps,
      debug: (m) => void debugs.push(m),
      host: { createTerminal: () => { throw new Error('pty gone'); } },
    });
    expect(await ops.create('t')).toBeUndefined();
    expect(messages.at(-1)).toMatch(/could not start/i);
    expect(debugs.some((m) => m.includes('pty gone'))).toBe(true);
    expect(ops.list()).toEqual([]);
  });

  it('keeps an existing session when a reopen fails to launch', async () => {
    const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
    const ops = createPlanningOps({ ...deps, scratchDir: () => '/dev/null/nope' });
    await expect(ops.open(s.id)).resolves.toBeUndefined();
    expect(messages.at(-1)).toMatch(/could not start/i);
    expect(getPlanningSession(store, s.id)!.status).toBe('active');
  });

  it('refuses to open an archived or unknown session', async () => {
    const ops = createPlanningOps(deps);
    const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
    setPlanningSessionStatus(store, s.id, 'archived');
    await ops.open(s.id);
    await ops.open(9999);
    expect(created).toHaveLength(0);
    expect(messages.filter((m) => /no longer exists/.test(m))).toHaveLength(2);
  });

  it('notifies a change when the planning terminal closes', async () => {
    const ops = createPlanningOps(deps);
    const s = (await ops.create('t'))!;
    changes = 0;
    created[0]!.close?.(0);
    expect(changes).toBe(1);
    expect(ops.isLive(s.id)).toBe(false);
  });

  it('unarchives to filed when it produced tickets, else to active', async () => {
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

  describe('planningSessionIdOf (tab-name fallback)', () => {
    const scratchDir = (id: number): string => join(scratch, String(id));
    const terminal: SessionTerminal = {
      show: () => undefined,
      sendText: () => undefined,
      dispose: () => undefined,
      onDidClose: () => undefined,
    };

    it('parses the new P<id> token', () => {
      expect(planningSessionIdOf({ name: 'P3 planner improvements', terminal }, scratchDir)).toBe(3);
    });

    it('still parses the legacy Karst plan #<id>: form so pre-upgrade terminals revive', () => {
      expect(planningSessionIdOf({ name: 'Karst plan #7: old', terminal }, scratchDir)).toBe(7);
    });

    it('ignores a name that is not a planning token', () => {
      expect(planningSessionIdOf({ name: 'zsh', terminal }, scratchDir)).toBeUndefined();
    });
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

    it('re-registers a surviving terminal by env, so open focuses it and archive disposes it', async () => {
      const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
      const ops = createPlanningOps(deps);
      const r = revived();
      ops.adopt([{ name: 'claude', env: { KARST_PLANNING_SESSION: String(s.id) }, terminal: r.terminal }]);
      expect(ops.isLive(s.id)).toBe(true);
      await ops.open(s.id);
      expect(created).toHaveLength(0);
      expect(r.rec.shown).toBe(1);
      ops.archive(s.id);
      expect(r.rec.disposed).toBe(true);
    });

    it('falls back to the scratch cwd, then the tab name, when the env is gone', async () => {
      const a = createPlanningSession(store, { projectId, title: 'a', core: 'claude', model: null });
      const b = createPlanningSession(store, { projectId, title: 'b', core: 'claude', model: null });
      const ops = createPlanningOps(deps);
      ops.adopt([
        { name: 'renamed by the agent', cwd: join(scratch, String(a.id)), terminal: revived().terminal },
        { name: `P${b.id} b`, terminal: revived().terminal },
      ]);
      expect(ops.isLive(a.id)).toBe(true);
      expect(ops.isLive(b.id)).toBe(true);
    });

    it('ignores archived, unknown, other-project, exited and foreign terminals', async () => {
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

    it('forgets an adopted terminal when it closes', async () => {
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
