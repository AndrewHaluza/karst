import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { exitsAfterFlush, parseGlobalFlags, runCli } from './main.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket, setAgentState } from '../store/tickets.js';
import { insertAttachment } from '../store/attachments.js';
import { upsertProject } from '../store/projects.js';
import { runNotesCommand } from './notesCommand.js';
import { transition } from '../workflow/machine.js';
import { createGraphRun } from '../store/graph/graphRuns.js';
import { createPlannerRun } from '../store/graph/plannerRuns.js';
import { sha256Hex } from './graph.js';

describe('parseGlobalFlags', () => {
  it('extracts --db and --manifest, leaving the subcommand argv', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9', '--db', '/x.db', '--manifest', '/k.yml', '--md']);
    expect(g.db).toBe('/x.db');
    expect(g.manifest).toBe('/k.yml');
    expect(g.rest).toEqual(['context', 'PROJ-9', '--md']);
  });

  it('extracts --ticket for the stage marker', () => {
    const g = parseGlobalFlags(['stage', 'impl', 'pass', '--db', '/x.db', '--ticket', 'K-1']);
    expect(g.db).toBe('/x.db');
    expect(g.ticket).toBe('K-1');
    expect(g.rest).toEqual(['stage', 'impl', 'pass']);
  });

  it('extracts --verbose', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9', '--verbose']);
    expect(g.verbose).toBe(true);
    expect(g.rest).toEqual(['context', 'PROJ-9']);
  });

  it('leaves flags absent when not given', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9']);
    expect(g.db).toBeUndefined();
    expect(g.manifest).toBeUndefined();
    expect(g.ticket).toBeUndefined();
    expect(g.verbose).toBeUndefined();
    expect(g.rest).toEqual(['context', 'PROJ-9']);
  });
});

describe('runCli — stage marker', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-'));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    createTicket(seed, { key: 'K-1', title: 'demo' });
    transition(seed, 1, 'scope', { kind: 'passed' }); // -> impl
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('advances impl->uat by ticket key and prints the next stage', () => {
    const out = runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1']);
    expect(out.trim()).toBe('uat');

    const check: Store = openStore(dbPath);
    const t = getTicket(check, 1);
    expect(t.stages.find((s) => s.stageKey === 'impl')?.status).toBe('passed');
    expect(t.stages.find((s) => s.stageKey === 'uat')?.status).toBe('running');
    check.close();
  });

  it('fails loudly on an unknown ticket key', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'NOPE'])).toThrow(/NOPE/);
  });

  it('refuses the impl marker while the agent is waiting for user input', () => {
    const seed = openStore(dbPath);
    setAgentState(seed, 1, 'waiting');
    seed.close();

    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1'])).toThrow(
      /waiting for|waiting on|asked/i,
    );

    const check: Store = openStore(dbPath);
    const t = getTicket(check, 1);
    expect(t.stageCurrent).toBe('impl');
    expect(t.stages.find((s) => s.stageKey === 'impl')?.status).toBe('running');
    check.close();
  });

  it('requires --ticket for a stage command', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath])).toThrow(/ticket/);
  });

  it('requires --db', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--ticket', 'K-1'])).toThrow(/db/);
  });

  it('rejects an unknown subcommand', () => {
    expect(() => runCli(['bogus', '--db', dbPath])).toThrow(/bogus|unknown/);
  });

  it('names every verb it accepts when the subcommand is unknown', () => {
    expect(() => runCli(['bogus', '--db', dbPath])).toThrow(/phase/);
  });

  it('names the current stage and the valid marker when the fired one is stale (gate stage)', () => {
    const seed = openStore(dbPath);
    transition(seed, 1, 'impl', { kind: 'passed' }); // -> uat
    seed.close();

    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1'])).toThrow(
      /already at stage 'uat'/,
    );
    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1'])).toThrow(
      /gate exit codes/,
    );
  });

  it('names the fix marker when a stale impl marker is fired at fix', () => {
    const seed = openStore(dbPath);
    transition(seed, 1, 'impl', { kind: 'passed' });
    transition(seed, 1, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    seed.close();

    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1'])).toThrow(
      /already at stage 'fix'/,
    );
    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1'])).toThrow(
      /'stage fix pass'/,
    );
  });
});

describe('runCli — populated attachment context over node:sqlite', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-attachments-'));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    const ticket = createTicket(seed, { key: 'MEDIA-1', title: 'has media' });
    insertAttachment(seed, {
      ticketId: ticket.id,
      kind: 'image',
      storedName: 'aaaa1111bbbb2222.png',
      originalName: 'screen.png',
      byteSize: 12,
    });
    insertAttachment(seed, {
      ticketId: ticket.id,
      kind: 'video',
      storedName: 'cccc3333dddd4444.mp4',
      originalName: 'repro.mov',
      byteSize: 34,
    });
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('renders absolute paths and the video unreadable marker through runCli', () => {
    const parsed = JSON.parse(
      runCli(['context', 'MEDIA-1', '--db', dbPath, '--json']),
    ) as { attachments: Array<{ kind: string; path: string; name: string }> };
    expect(parsed.attachments).toEqual([
      {
        kind: 'image',
        path: join(dir, 'attachments', '1', 'aaaa1111bbbb2222.png'),
        name: 'screen.png',
      },
      {
        kind: 'video',
        path: join(dir, 'attachments', '1', 'cccc3333dddd4444.mp4'),
        name: 'repro.mov',
      },
    ]);

    const markdown = runCli(['context', 'MEDIA-1', '--db', dbPath, '--md']);
    expect(markdown).toContain(
      `- video: ${join(dir, 'attachments', '1', 'cccc3333dddd4444.mp4')} — "repro.mov" (not agent-readable)`,
    );
  });
});

describe('runCli — legacy manifest deprecation warning', () => {
  let dir: string;
  let dbPath: string;
  let legacyManifestPath: string;

  const LEGACY_MANIFEST = `
id: proj
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
    ports:
      - { name: http, env: PORT, default: 3000 }
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-legacy-'));
    dbPath = join(dir, 'karst.db');
    legacyManifestPath = join(dir, 'karst.yml');
    writeFileSync(legacyManifestPath, LEGACY_MANIFEST);
    const seed = openStore(dbPath);
    createTicket(seed, { key: 'K-1', title: 'demo' });
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the legacy-manifest warning to stderr, prefixed `karst: `, and keeps stdout clean', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = runCli(['context', 'K-1', '--db', dbPath, '--manifest', legacyManifestPath]);

      expect(out).not.toMatch(/legacy/i);
      expect(out).not.toMatch(/karst:/);

      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toMatch(/^karst: /m);
      expect(written).toMatch(/legacy `services:` key/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('surfaces the warning for the stage marker path too (loadProjectSlug)', () => {
    // Closed, not leaked: the registry file is deleted in afterEach, and Windows
    // refuses to unlink a database another handle still has open.
    const seed = openStore(dbPath);
    transition(seed, 1, 'scope', { kind: 'passed' });
    seed.close();
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1', '--manifest', legacyManifestPath]);
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toMatch(/karst: .*legacy `services:` key/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('reports no warning for a current (non-legacy) manifest', () => {
    const currentPath = join(dir, 'current.yml');
    writeFileSync(
      currentPath,
      `
id: proj2
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
`,
    );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      runCli(['context', 'K-1', '--db', dbPath, '--manifest', currentPath]);
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).not.toMatch(/legacy/i);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('omits inert-key notices by default, even when manifest debug is true', () => {
    const manifestWithInertKeys = join(dir, 'inert.yml');
    writeFileSync(
      manifestWithInertKeys,
      `
id: proj3
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
debug: true
repositories:
  backend:
    repoPath: ../backend
uat:
  secrets:
    - API_KEY
  origins:
    - http://localhost:3000
`,
    );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = runCli(['context', 'K-1', '--db', dbPath, '--manifest', manifestWithInertKeys, '--json']);
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).not.toContain('not yet active');
      // stdout is consumed by an agent — it must stay parseable.
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes inert-key notices to stderr with --verbose, keeping stdout clean JSON', () => {
    const manifestWithInertKeys = join(dir, 'inert-verbose.yml');
    writeFileSync(
      manifestWithInertKeys,
      `
id: proj4
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
uat:
  secrets:
    - API_KEY
  origins:
    - http://localhost:3000
`,
    );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = runCli(['context', 'K-1', '--db', dbPath, '--manifest', manifestWithInertKeys, '--json', '--verbose']);
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('uat.secrets');
      expect(written).toContain('not yet active');
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('runCli — graph submit (Slice-2 T6)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-graph-'));
    dbPath = join(dir, 'karst.db');
    const store = openStore(dbPath);
    const projectId = Number(
      store.db.prepare("INSERT INTO projects (slug) VALUES ('project')").run().lastInsertRowid,
    );
    const ticketId = Number(
      store.db
        .prepare('INSERT INTO tickets (key, project_id) VALUES (?, ?)')
        .run('T-1', projectId).lastInsertRowid,
    );
    const graphRunId = createGraphRun(store.db, {
      ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: '2026-08-11T00:00:00.000Z',
    });
    const plannerRunId = createPlannerRun(store.db, {
      graphRunId,
      plannerRunNumber: 1,
      kind: 'bootstrap',
    });
    const capability = 'c'.repeat(64);
    store.db
      .prepare(
        `UPDATE approach_planner_runs
         SET status = 'running', generation = 'gen-1', capability_hash = ?
         WHERE id = ?`,
      )
      .run(sha256Hex(new TextEncoder().encode(capability)), plannerRunId);
    store.close();
    writeFileSync(join(dir, 'graph.json'), '{"version":1}');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('submits through runCli using the host-owned environment (no --ticket)', () => {
    vi.stubEnv('KARST_GRAPH_DB', dbPath);
    vi.stubEnv('KARST_GRAPH_PROJECT', '1');
    vi.stubEnv('KARST_TICKET_ID', '1');
    vi.stubEnv('KARST_GRAPH_RUN_ID', '1');
    vi.stubEnv('KARST_LAUNCH_ID', '1');
    vi.stubEnv('KARST_GRAPH_GENERATION', 'gen-1');
    vi.stubEnv('KARST_GRAPH_CAPABILITY', 'c'.repeat(64));
    vi.stubEnv('KARST_GRAPH_ARTIFACT_ROOT', dir);
    try {
      const out = runCli(['graph', 'submit']);
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
      expect(parsed.graphRunId).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('runCli — subtask create (design NDL-70 §7)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-subtask-'));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    const parent = createTicket(seed, { key: 'K-1', title: 'demo' });
    seed.db
      .prepare("UPDATE tickets SET selected_repos = '[\"frontend\"]' WHERE id = ?")
      .run(parent.id);
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('carves a sub-task out of the --ticket ticket and names the new key', () => {
    const out = runCli([
      'subtask',
      'create',
      '--title',
      'Carve this out',
      '--blocking',
      '--db',
      dbPath,
      '--ticket',
      'K-1',
    ]);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, key: 'K-1-s1', parent: 'K-1', blocking: true });

    const check = openStore(dbPath);
    const child = getTicket(check, parsed.id);
    expect(child.subtaskParentId).toBe(1);
    expect(child.selectedRepos).toEqual(['frontend']);
    check.close();
  });

  it('requires --ticket and --db', () => {
    expect(() => runCli(['subtask', 'create', '--title', 'x', '--db', dbPath])).toThrow(/ticket/);
    expect(() => runCli(['subtask', 'create', '--title', 'x', '--ticket', 'K-1'])).toThrow(/db/);
  });

  it('names the verb in the unknown-command message', () => {
    expect(() => runCli(['bogus', '--db', dbPath])).toThrow(/subtask/);
  });
});

describe('runCli — message / inbox (parent<->child mailbox)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-message-'));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    const parent = createTicket(seed, { key: 'K-1', title: 'demo' });
    createTicket(seed, { key: 'K-1-s1', title: 'child', subtaskParentId: parent.id });
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('child sends to parent; parent reads it once via inbox', () => {
    const sent = JSON.parse(
      runCli(
        ['message', 'send', '--to', 'parent', '--body', 'blocked', '--db', dbPath, '--ticket', 'K-1-s1'],
        { KARST_TICKET: 'K-1-s1' },
      ),
    );
    expect(sent).toMatchObject({ ok: true, to: 'K-1' });
    const out = runCli(['inbox', '--db', dbPath, '--ticket', 'K-1'], { KARST_TICKET: 'K-1' });
    expect(out).toContain('from sub-task agent K-1-s1 (untrusted):');
    expect(runCli(['inbox', '--db', dbPath, '--ticket', 'K-1'], { KARST_TICKET: 'K-1' })).toMatch(/no unread/i);
  });

  it('refuses message send without KARST_TICKET', () => {
    expect(() =>
      runCli(['message', 'send', '--to', 'parent', '--body', 'x', '--db', dbPath, '--ticket', 'K-1-s1'], {}),
    ).toThrow(/KARST_TICKET/);
  });

  it('refuses a --ticket that disagrees with the session env KARST_TICKET', () => {
    expect(() =>
      runCli(['inbox', '--db', dbPath, '--ticket', 'K-1'], { KARST_TICKET: 'K-1-s1' }),
    ).toThrow(/KARST_TICKET/);
  });

  it('reads KARST_TICKET from process.env by default', () => {
    vi.stubEnv('KARST_TICKET', 'K-1-s1');
    try {
      expect(() => runCli(['inbox', '--db', dbPath, '--ticket', 'K-1'])).toThrow(/KARST_TICKET/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('requires --ticket and --db, and lists both verbs in the unknown-command message', () => {
    expect(() => runCli(['inbox', '--db', dbPath], {})).toThrow(/ticket/);
    expect(() => runCli(['inbox', '--ticket', 'K-1'], {})).toThrow(/db/);
    expect(() => runCli(['bogus', '--db', dbPath], {})).toThrow(/'message'.*'inbox'/);
  });

  it('does not change how parseGlobalFlags parses message flags', () => {
    expect(parseGlobalFlags(['message', 'send', '--to', 'parent', '--ticket', 'K-1']).rest).toEqual([
      'message',
      'send',
      '--to',
      'parent',
    ]);
  });
});

describe('runCli — draft propose (planning sessions)', () => {
  let dir: string;
  const proposal = JSON.stringify({ title: 'Add auth', description: 'd', summary: 's', repos: ['api'] });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-cli-propose-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a proposal into KARST_OUTBOX from stdin without any store', () => {
    const out = JSON.parse(
      runCli(['draft', 'propose'], { KARST_OUTBOX: dir }, { readStdin: () => proposal, timeoutMs: 0 }),
    );
    expect(out.ok).toBe(true);
    expect(readdirSync(dir)).toEqual([basename(out.file)]);
  });

  it('draft list reads the session index and opens no store', () => {
    const indexPath = join(dirname(dir), 'proposals.json');
    writeFileSync(
      indexPath,
      JSON.stringify([{ id: 1, uuid: 'u', title: 'A', status: 'pending', updatedAt: 't' }]),
    );
    const out = JSON.parse(runCli(['draft', 'list'], { KARST_OUTBOX: dir }, { readStdin: () => '' }));
    expect(out).toEqual([{ id: 1, status: 'pending', title: 'A' }]);
    rmSync(indexPath, { force: true });
  });

  it('refuses --db / --manifest / --session and never opens a store', () => {
    const db = join(dir, 'karst.db');
    for (const extra of [['--db', db], ['--manifest', join(dir, 'k.yml')], ['--session', '1']]) {
      expect(() =>
        runCli(['draft', 'propose', ...extra], { KARST_OUTBOX: dir }, { readStdin: () => proposal, timeoutMs: 0 }),
      ).toThrow(/draft propose/);
    }
    expect(existsSync(db)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('requires KARST_OUTBOX', () => {
    expect(() => runCli(['draft', 'propose'], {}, { readStdin: () => proposal })).toThrow(/KARST_OUTBOX/);
  });
});

describe('runCli — manifest / setup (setup sessions)', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-cli-setup-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const validYaml = `host: localhost\nportRange: [4000, 4999]\nbaselineBranch: main\nrepositories:\n  web:\n    repoPath: ../web\n`;

  it('routes `manifest validate --file` through the real loader', () => {
    const file = join(dir, 'draft.yml');
    writeFileSync(file, validYaml);
    const out = JSON.parse(runCli(['manifest', 'validate', '--file', file]));
    expect(out.ok).toBe(true);
    expect(out.repositories).toEqual(['web']);
  });

  it('routes `manifest propose --file` into KARST_SETUP_OUTBOX', () => {
    const file = join(dir, 'draft.yml');
    writeFileSync(file, validYaml);
    const out = JSON.parse(runCli(['manifest', 'propose', '--file', file], { KARST_SETUP_OUTBOX: dir }));
    expect(out).toMatchObject({ ok: true, kind: 'manifest' });
    expect(readdirSync(dir).some((f) => f.endsWith('.json'))).toBe(true);
  });

  it('routes `setup propose-change` from structured --stdin input', () => {
    const change = JSON.stringify({ subcommand: 'propose-change', repo: 'web', reason: 'r', command: 'npm ci' });
    const out = JSON.parse(
      runCli(['setup', 'propose-change', '--stdin'], { KARST_SETUP_OUTBOX: dir }, { readStdin: () => change }),
    );
    expect(out).toMatchObject({ ok: true, kind: 'change' });
  });

  it('accepts the flat MCP tool object (globals + stdin, no --stdin token)', () => {
    // The MCP runner emits `setup propose-change` plus the global --db/--manifest
    // and feeds the validated tool object on stdin; the handler must normalize it.
    const change = JSON.stringify({ subcommand: 'propose-change', repo: 'web', reason: 'r', command: 'npm ci' });
    const out = JSON.parse(
      runCli(
        ['setup', 'propose-change', '--db', join(dir, 'x.db'), '--manifest', join(dir, 'k.yml')],
        { KARST_SETUP_OUTBOX: dir },
        { readStdin: () => change },
      ),
    );
    expect(out).toMatchObject({ ok: true, kind: 'change' });
  });

  it('routes `setup discover` with structured input', () => {
    const input = JSON.stringify({ subcommand: 'discover', root: dir });
    const out = JSON.parse(runCli(['setup', 'discover', '--stdin'], {}, { readStdin: () => input }));
    expect(out.empty).toBe(true);
  });
});

describe('exitsAfterFlush', () => {
  // Both verbs start `detached` children through the same runtime, whose
  // ChildProcess handles pin the short-lived CLI's event loop. If this decision
  // misses a verb, that invocation prints its result and then hangs forever —
  // which is exactly what `setup verify` did on a successful spin.
  it('force-exits the async verbs whose detached children pin the event loop', () => {
    expect(exitsAfterFlush(['servers', 'list'])).toBe(true);
    expect(exitsAfterFlush(['setup', 'verify'])).toBe(true);
    expect(exitsAfterFlush(['setup', 'verify', '--repos', 'web'])).toBe(true);
  });

  it('leaves the ordinary synchronous verbs writing and returning normally', () => {
    expect(exitsAfterFlush(['setup', 'discover'])).toBe(false);
    expect(exitsAfterFlush(['setup', 'propose-change'])).toBe(false);
    expect(exitsAfterFlush(['context', 'PROJ-9'])).toBe(false);
    expect(exitsAfterFlush([])).toBe(false);
  });
});

describe('runCli — notes --repos (planner read, real db)', () => {
  let dir: string;
  let db: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-cli-notes-repos-')));
    db = join(dir, 'karst.db');
    const store = openStore(db);
    const projectId = upsertProject(store, { slug: 'p1' }).id;
    const author = createTicket(store, { key: 'K-1', title: 'author', projectId }).id;
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(author, 'api', '/wt/api', 'karst/api', 'main');
    runNotesCommand(store, getTicket(store, author)!, ['notes', 'post', '--title', 'api tip', '--body', 'b'], {
      sessionTicketKey: 'K-1',
    });
    store.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads by project without a ticket and marks nothing read', () => {
    const out = runCli(['--db', db, 'notes', '--repos', 'api'], { KARST_PROJECT: '1' });
    expect(out).toContain('api tip');
    const store = openStore(db);
    const reads = store.db.prepare('SELECT COUNT(*) AS n FROM bulletin_reads').get() as { n: number };
    store.close();
    expect(reads.n).toBe(0);
  });

  it('refuses a missing or invalid KARST_PROJECT and never falls back to cwd', () => {
    expect(() => runCli(['--db', db, 'notes', '--repos', 'api'], {})).toThrow(/notes --repos needs KARST_PROJECT/);
    expect(() => runCli(['--db', db, 'notes', '--repos', 'api'], { KARST_PROJECT: 'x' })).toThrow(
      /notes --repos needs KARST_PROJECT/,
    );
  });

  it('refuses --repos combined with post', () => {
    expect(() =>
      runCli(['--db', db, 'notes', 'post', '--repos', 'api', '--title', 'T', '--body', 'B'], { KARST_PROJECT: '1' }),
    ).toThrow(/cannot be combined with post/);
  });
});

describe('runCli — pause and unpause', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-cli-pause-')));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    const parent = createTicket(seed, { key: 'PARENT-1', title: 'Parent' });
    createTicket(seed, { key: 'CHILD-1', title: 'Child', subtaskParentId: parent.id });
    createTicket(seed, { key: 'OTHER-1', title: 'Other' });
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('pauses and unpauses the session ticket itself', () => {
    const pauseOut = runCli(['pause', 'PARENT-1', '--db', dbPath, '--ticket', 'PARENT-1']);
    const pauseParsed = JSON.parse(pauseOut);
    expect(pauseParsed).toEqual({ ok: true, ticketId: 1, paused: true });

    let check = openStore(dbPath);
    expect(getTicket(check, 1).pausedAt).not.toBeNull();
    check.close();

    const unpauseOut = runCli(['unpause', 'PARENT-1', '--db', dbPath, '--ticket', 'PARENT-1']);
    const unpauseParsed = JSON.parse(unpauseOut);
    expect(unpauseParsed).toEqual({ ok: true, ticketId: 1, paused: false });

    check = openStore(dbPath);
    expect(getTicket(check, 1).pausedAt).toBeNull();
    check.close();
  });

  it('pauses and unpauses a direct sub-task', () => {
    const pauseOut = runCli(['pause', 'CHILD-1', '--db', dbPath, '--ticket', 'PARENT-1']);
    const pauseParsed = JSON.parse(pauseOut);
    expect(pauseParsed).toEqual({ ok: true, ticketId: 2, paused: true });

    let check = openStore(dbPath);
    expect(getTicket(check, 2).pausedAt).not.toBeNull();
    check.close();

    const unpauseOut = runCli(['unpause', 'CHILD-1', '--db', dbPath, '--ticket', 'PARENT-1']);
    const unpauseParsed = JSON.parse(unpauseOut);
    expect(unpauseParsed).toEqual({ ok: true, ticketId: 2, paused: false });

    check = openStore(dbPath);
    expect(getTicket(check, 2).pausedAt).toBeNull();
    check.close();
  });

  it('uses KARST_TICKET env when --ticket is omitted', () => {
    const pauseOut = runCli(['pause', 'CHILD-1', '--db', dbPath], { KARST_TICKET: 'PARENT-1' });
    const pauseParsed = JSON.parse(pauseOut);
    expect(pauseParsed).toEqual({ ok: true, ticketId: 2, paused: true });
  });

  it('refuses to pause an unrelated ticket', () => {
    expect(() =>
      runCli(['pause', 'OTHER-1', '--db', dbPath, '--ticket', 'PARENT-1']),
    ).toThrow(/refusing: session ticket 'PARENT-1' may only pause itself and its direct sub-tasks/);
  });

  it('refuses to unpause an unrelated ticket', () => {
    expect(() =>
      runCli(['unpause', 'OTHER-1', '--db', dbPath, '--ticket', 'PARENT-1']),
    ).toThrow(/refusing: session ticket 'PARENT-1' may only unpause itself and its direct sub-tasks/);
  });
});
