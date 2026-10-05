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
import { parseDraftCreateArgs, runDraftCommand, type DraftDeps } from './draftCommand.js';

const FILES: Record<string, string> = { '/d.md': 'Full description', '/s.md': 'Decided: use JWT' };

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
      readFile: (path) => {
        const text = FILES[path];
        if (text === undefined) throw new Error(`ENOENT ${path}`);
        return text;
      },
    };
  });
  afterEach(() => store.close());

  const argv = (extra: string[] = []): string[] => [
    'draft', 'create', '--session', String(sessionId), '--title', 'Add JWT auth',
    '--description-file', '/d.md', '--summary-file', '/s.md', '--repos', 'api', ...extra,
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

  it('refuses an oversized file', () => {
    const big = { ...deps, readFile: () => 'x'.repeat(70_000) };
    expect(() => runDraftCommand(store, argv(), big)).toThrow(/too large/);
  });
});
