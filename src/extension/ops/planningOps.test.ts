import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { getPlanningSession, linkPlanningTicket } from '../../store/planningSessions.js';
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
  beforeEach(() => {
    store = openStore(':memory:');
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
      stackRoot: () => '/src',
      defaultAgent: () => ({ provider: 'claude', model: 'opus' }),
      host: fake.host,
      cli: { cliEntry: '/dist/cli/main.js', dbPath: '/db/karst.db', manifestPath: '/src/karst.yml' },
      notify: { info: (m) => void messages.push(m), warn: (m) => void messages.push(m), error: async () => undefined },
    };
  });
  afterEach(() => store.close());

  it('creates a session and launches a read-only agent across every repo', () => {
    const ops = createPlanningOps(deps);
    const session = ops.create('Auth rework')!;
    expect(session).toMatchObject({ title: 'Auth rework', core: 'claude', model: 'opus', status: 'active' });
    const { opts } = created[0]!;
    expect(opts.cwd).toBe('/src');
    expect(opts.name).toBe('Karst plan: Auth rework');
    expect(opts.shellArgs).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--add-dir', '/src/api', '/src/web']));
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
    ops.archive(s.id);
    expect(created[0]!.disposed).toBe(true);
    expect(getPlanningSession(store, s.id)!.status).toBe('archived');
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
});
