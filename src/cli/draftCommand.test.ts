import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { findTicketById } from '../store/tickets.js';
import {
  createPlanningSession,
  getPlanningSession,
  listPlanningTickets,
  setPlanningSessionStatus,
} from '../store/planningSessions.js';
import { MAX_DRAFT_FILE_BYTES, parseDraftCreateArgs, runDraftCommand, type DraftDeps, type DraftFs } from './draftCommand.js';

const FILES: Record<string, string> = { '/scratch/d.md': 'Full description', '/scratch/s.md': 'Decided: use JWT' };

/** A fake filesystem rooted at `/scratch` (the session cwd). */
function fakeFs(over: Partial<DraftFs> = {}): DraftFs {
  return {
    cwd: () => '/scratch',
    lstat: (path) => {
      const text = FILES[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return { isFile: true, isSymbolicLink: false, size: Buffer.byteLength(text) };
    },
    realpath: (path) => path,
    readFile: (path) => FILES[path]!,
    ...over,
  };
}

describe('parseDraftCreateArgs', () => {
  it('parses every flag', () => {
    expect(
      parseDraftCreateArgs([
        'draft', 'create', '--session', '3', '--title', ' T ', '--description-file', '/d.md',
        '--repos', 'api, web', '--summary-file', '/s.md',
      ]),
    ).toEqual({ sessionId: 3, title: 'T', descriptionFile: '/d.md', repos: ['api', 'web'], summaryFile: '/s.md' });
  });

  it('rejects an unknown flag, a missing title, and a non-numeric session', () => {
    expect(() => parseDraftCreateArgs(['draft', 'create', '--session', '1', '--title', 't', '--start'])).toThrow(/--start/);
    expect(() => parseDraftCreateArgs(['draft', 'create', '--session', '1'])).toThrow(/--title/);
    expect(() => parseDraftCreateArgs(['draft', 'create', '--session', 'x', '--title', 't'])).toThrow(/--session/);
  });
});

describe('runDraftCommand', () => {
  let store: Store;
  let sessionId: number;
  let deps: DraftDeps;
  beforeEach(() => {
    store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 'plan', core: 'claude', model: null }).id;
    deps = {
      sessionEnv: String(sessionId),
      knownRepos: ['api', 'web'],
      projectSlug: 'p',
      fs: fakeFs(),
    };
  });
  afterEach(() => store.close());

  const argv = (extra: string[] = []): string[] => [
    'draft', 'create', '--session', String(sessionId), '--title', 'Add JWT auth',
    '--description-file', '/scratch/d.md', '--summary-file', '/scratch/s.md', '--repos', 'api', ...extra,
  ];

  it('creates a scope-stage draft in the session project, with the summary as its brief, and links it', () => {
    const out = JSON.parse(runDraftCommand(store, argv(), deps));
    const ticket = findTicketById(store, out.id)!;
    expect(ticket).toMatchObject({
      title: 'Add JWT auth',
      description: 'Full description',
      brief: 'Decided: use JWT',
      selectedRepos: ['api'],
      stageCurrent: 'scope',
      autostartPending: false,
      projectId: getPlanningSession(store, sessionId)!.projectId,
    });
    expect(listPlanningTickets(store, sessionId)).toEqual([out.id]);
    expect(getPlanningSession(store, sessionId)!.status).toBe('filed');
  });

  it('refuses without a matching KARST_PLANNING_SESSION', () => {
    expect(() => runDraftCommand(store, argv(), { ...deps, sessionEnv: undefined })).toThrow(/KARST_PLANNING_SESSION/);
    expect(() => runDraftCommand(store, argv(), { ...deps, sessionEnv: '999' })).toThrow(/KARST_PLANNING_SESSION/);
  });

  it('refuses an archived or unknown session', () => {
    setPlanningSessionStatus(store, sessionId, 'archived');
    expect(() => runDraftCommand(store, argv(), deps)).toThrow(/archived/);
  });

  it('refuses a repository the manifest does not declare', () => {
    expect(() => runDraftCommand(store, argv(['--repos', 'evil']), deps)).toThrow(/evil/);
  });

  it('fails closed on --repos when the manifest repositories are unknown', () => {
    expect(() => runDraftCommand(store, argv(), { ...deps, knownRepos: undefined })).toThrow(/manifest/);
    // Without --repos there is nothing to check, so no manifest is needed.
    const noRepos = argv().slice(0, -2);
    expect(() => runDraftCommand(store, noRepos, { ...deps, knownRepos: undefined })).not.toThrow();
  });

  it('refuses a session that belongs to another project than the manifest', () => {
    expect(() => runDraftCommand(store, argv(), { ...deps, projectSlug: 'other' })).toThrow(/project/);
    expect(listPlanningTickets(store, sessionId)).toEqual([]);
  });

  it('refuses an oversized file BEFORE reading it', () => {
    let read = false;
    const fs = fakeFs({
      lstat: () => ({ isFile: true, isSymbolicLink: false, size: MAX_DRAFT_FILE_BYTES + 1 }),
      readFile: () => { read = true; return ''; },
    });
    expect(() => runDraftCommand(store, argv(), { ...deps, fs })).toThrow(/too large/);
    expect(read).toBe(false);
  });

  it('refuses a symlink', () => {
    const fs = fakeFs({ lstat: () => ({ isFile: false, isSymbolicLink: true, size: 10 }) });
    expect(() => runDraftCommand(store, argv(), { ...deps, fs })).toThrow(/regular file/);
  });

  it('refuses a FIFO or device (not a regular file)', () => {
    const fs = fakeFs({ lstat: () => ({ isFile: false, isSymbolicLink: false, size: 0 }) });
    expect(() => runDraftCommand(store, argv(), { ...deps, fs })).toThrow(/regular file/);
  });

  it('refuses a file outside the session scratch directory', () => {
    const fs = fakeFs({ realpath: (p) => (p === '/scratch' ? p : p.replace('/scratch', '/etc')) });
    expect(() => runDraftCommand(store, argv(), { ...deps, fs })).toThrow(/outside/);
    const sibling = fakeFs({ realpath: (p) => (p === '/scratch' ? p : p.replace('/scratch', '/scratch-evil')) });
    expect(() => runDraftCommand(store, argv(), { ...deps, fs: sibling })).toThrow(/outside/);
  });

  it('leaves no ticket behind when a later write fails', () => {
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number };
    const failing = { ...deps, link: () => { throw new Error('link boom'); } };
    expect(() => runDraftCommand(store, argv(), failing)).toThrow(/link boom/);
    const after = store.db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
