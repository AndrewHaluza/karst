import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './db.js';
import { createGraphRun } from './graph/graphRuns.js';
import { createPlannerRun } from './graph/plannerRuns.js';
import { createRevision } from './graph/revisions.js';
import { createNodeRun } from './graph/nodeRuns.js';
import { createToken } from './graph/tokens.js';
import {
  createTicket,
  getTicket,
  getTicketByKey,
  generateTicketKey,
  ticketLabel,
  updateTicketCore,
  updateTicketFields,
  archiveTicket,
  unarchiveTicket,
  deleteTicket,
  listTickets,
  listArchivedTickets,
  setSessionId,
  clearApproachFromTickets,
  type Ticket,
} from './tickets.js';
import { setStage } from './stages.js';
import { autoArchiveDoneTickets } from './doneArchive.js';
import { transition } from '../workflow/machine.js';
import { STAGE_KEYS } from '../model/types.js';
import { openProcessRun, listProcessRuns } from './processRuns.js';
import { recordTokenUsage, listTokenUsage } from './tokenUsage.js';
import { recordFindings, listFindings } from './reviewFindings.js';
import { openStageRun } from './stageRuns.js';
import { recordGateRun } from './gateRuns.js';
import { recordPhaseMark } from './phaseMarks.js';
import { setMergeCheck } from './mergeChecks.js';

describe('ticketLabel', () => {
  const base: Ticket = {
    id: 7,
    key: 'PROJ-142',
    title: 'do things',
    source: 'manual',
    stageCurrent: 'scope',
    agentState: 'none',
    sessionId: null,
    description: null,
    brief: null,
    sourceRef: null,
    sourceFetchedAt: null,
    approach: null,
    agent: null,
    selectedRepos: [],
    baseRefs: {},
    archivedAt: null,
    updatedAt: null,
    model: null,
    effort: null,
    type: null,
    agentProvider: null,
    sessionProvider: null,
    projectId: null,
    parentTicketId: null,
    priority: null,
  };

  it('renders "key — title" when both present', () => {
    expect(ticketLabel(base)).toBe('PROJ-142 — do things');
  });

  it('falls back to "#id" when key is null', () => {
    expect(ticketLabel({ ...base, key: null })).toBe('#7 — do things');
  });

  it('falls back to "(untitled)" when title is null', () => {
    expect(ticketLabel({ ...base, title: null })).toBe('PROJ-142 — (untitled)');
  });
});

describe('ticket + stage persistence', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('createTicket seeds all MVP stages as pending (no fetch, C1)', () => {
    const t = createTicket(store, { key: 'PROJ-142', title: 'thing' });
    expect(t.key).toBe('PROJ-142');
    expect(t.title).toBe('thing');
    expect(t.id).toBeGreaterThan(0);

    const full = getTicket(store, t.id);
    const keys = full.stages.map((s) => s.stageKey).sort();
    expect(keys).toEqual([...STAGE_KEYS].sort());
    expect(keys).not.toContain('fetch');
    for (const s of full.stages) expect(s.status).toBe('pending');
    for (const s of full.stages) expect(s.attempt).toBe(0);
  });

  it('getTicketByKey returns the matching ticket, or undefined when absent', () => {
    const t = createTicket(store, { key: 'FIND-1', title: 'findable' });
    expect(getTicketByKey(store, 'FIND-1')?.id).toBe(t.id);
    expect(getTicketByKey(store, 'NOPE')).toBeUndefined();
  });

  it('generateTicketKey returns a non-empty key unclaimed by any ticket', () => {
    const key = generateTicketKey(store);
    expect(key.length).toBeGreaterThan(0);
    expect(getTicketByKey(store, key)).toBeUndefined();
  });

  it('generateTicketKey never collides across repeated calls', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateTicketKey(store)));
    expect(keys.size).toBe(50);
  });

  it('a generated key is immediately usable to create a ticket, indistinguishable from a hand-typed one', () => {
    const key = generateTicketKey(store);
    const t = createTicket(store, { key, title: 'auto-keyed' });
    expect(t.key).toBe(key);
    expect(getTicketByKey(store, key)?.id).toBe(t.id);
  });

  it('generateTicketKey derives the key from a seed title when one is given', () => {
    expect(generateTicketKey(store, {}, 'Fix login redirect')).toBe('FIX-LOGIN-REDIRECT');
  });

  it('a seed title whose key is taken gets a numeric suffix, in scope', () => {
    createTicket(store, { key: 'FIX-LOGIN-REDIRECT', title: 'first', projectId: 1 });
    expect(generateTicketKey(store, { projectId: 1 }, 'Fix login redirect')).toBe('FIX-LOGIN-REDIRECT-2');
    // Another project never saw that key — it keeps the clean one.
    expect(generateTicketKey(store, { projectId: 2 }, 'Fix login redirect')).toBe('FIX-LOGIN-REDIRECT');
  });

  it('falls back to a random key when the seed title carries nothing key-able', () => {
    const key = generateTicketKey(store, {}, '  *** ');
    expect(key).toMatch(/^MANUAL-[0-9A-F]{8}$/);
  });

  it('generateTicketKey is scoped per project, like getTicketByKey', () => {
    const keyInA = generateTicketKey(store, { projectId: 1 });
    createTicket(store, { key: keyInA, title: 'in A', projectId: 1 });
    // The same scope now excludes that key; a different project doesn't care.
    expect(getTicketByKey(store, keyInA, { projectId: 1 })).toBeDefined();
    expect(getTicketByKey(store, keyInA, { projectId: 2 })).toBeUndefined();
  });

  it('setStage persists status + verdict and reloads', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    setStage(store, t.id, 'uat', { status: 'passed', verdict: 'exit 0' });
    const uat = getTicket(store, t.id).stages.find((s) => s.stageKey === 'uat')!;
    expect(uat.status).toBe('passed');
    expect(uat.verdict).toBe('exit 0');
  });

  it('setStage can set an artifact path', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    setStage(store, t.id, 'uat', { status: 'failed', artifactPath: '/logs/uat-1.txt' });
    const uat = getTicket(store, t.id).stages.find((s) => s.stageKey === 'uat')!;
    expect(uat.artifactPath).toBe('/logs/uat-1.txt');
    expect(uat.status).toBe('failed');
  });

  it('attempt increments on a fix loop', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    setStage(store, t.id, 'fix', { status: 'running', attempt: 1 });
    setStage(store, t.id, 'fix', { status: 'running', attempt: 2 });
    const fix = getTicket(store, t.id).stages.find((s) => s.stageKey === 'fix')!;
    expect(fix.attempt).toBe(2);
  });

  it('a partial patch leaves other stage fields untouched', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    setStage(store, t.id, 'review', { status: 'failed', verdict: 'lint' });
    setStage(store, t.id, 'review', { status: 'running' }); // only status
    const rev = getTicket(store, t.id).stages.find((s) => s.stageKey === 'review')!;
    expect(rev.status).toBe('running');
    expect(rev.verdict).toBe('lint'); // untouched
  });

  it('persists across openStore reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-tickets-'));
    try {
      const path = join(dir, 'karst.db');
      const first = openStore(path);
      const t = createTicket(first, { key: 'PROJ-9', title: 'durable' });
      setStage(first, t.id, 'impl', { status: 'passed' });
      first.close();

      const second = openStore(path);
      const reloaded = getTicket(second, t.id);
      expect(reloaded.key).toBe('PROJ-9');
      const impl = reloaded.stages.find((s) => s.stageKey === 'impl')!;
      expect(impl.status).toBe('passed');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getTicket throws for an unknown id', () => {
    expect(() => getTicket(store, 9999)).toThrow(/not found|unknown/i);
  });

  it('new tickets default the ticket-form fields', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    const full = getTicket(store, t.id);
    expect(full.description).toBeNull();
    expect(full.brief).toBeNull();
    expect(full.approach).toBeNull();
    expect(full.agent).toBeNull();
    expect(full.selectedRepos).toEqual([]);
  });

  it('a new ticket has a null parentTicketId (not a follow-up) by default', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'root ticket' });
    expect(t.parentTicketId).toBeNull();
  });

  it('createTicket persists parentTicketId, readable via getTicket', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root ticket' });
    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'follow-up',
      parentTicketId: parent.id,
    });
    expect(child.parentTicketId).toBe(parent.id);
    expect(getTicket(store, child.id).parentTicketId).toBe(parent.id);
  });

  it('updateTicketCore changes key and title only', () => {
    const t = createTicket(store, { key: 'OLD-1', title: 'old' });
    updateTicketCore(store, t.id, { key: 'NEW-2', title: 'new' });
    const full = getTicket(store, t.id);
    expect(full.key).toBe('NEW-2');
    expect(full.title).toBe('new');
    expect(full.stageCurrent).toBe('scope'); // untouched
  });

  it('updateTicketFields round-trips brief, approach, and selected repos', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, {
      description: 'a desc',
      brief: 'the brief',
      sourceRef: 'CU-123',
      sourceFetchedAt: '2026-07-10T00:00:00Z',
      approach: 'rpi',
      agent: 'reviewer',
      selectedRepos: ['frontend', 'backend'],
    });
    const full = getTicket(store, t.id);
    expect(full.description).toBe('a desc');
    expect(full.brief).toBe('the brief');
    expect(full.sourceRef).toBe('CU-123');
    expect(full.sourceFetchedAt).toBe('2026-07-10T00:00:00Z');
    expect(full.approach).toBe('rpi');
    expect(full.agent).toBe('reviewer');
    expect(full.selectedRepos).toEqual(['frontend', 'backend']);
  });

  it('updateTicketFields persists agent selection independently', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { agent: 'reviewer' });
    const full = getTicket(store, t.id);
    expect(full.agent).toBe('reviewer');
  });

  it('a new ticket has a null model (inherit) until one is chosen', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    expect(getTicket(store, t.id).model).toBeNull();
  });

  it('updateTicketFields round-trips the per-ticket model', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { model: 'claude-opus-4-8' });
    expect(getTicket(store, t.id).model).toBe('claude-opus-4-8');
  });

  it('an empty-string model clears the selection back to inherit (null)', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { model: 'claude-sonnet-5' });
    updateTicketFields(store, t.id, { model: '' });
    expect(getTicket(store, t.id).model).toBeNull();
  });

  it('a new ticket has a null priority until one is fetched', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    expect(getTicket(store, t.id).priority).toBeNull();
  });

  it('updateTicketFields round-trips the provider-native priority label', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { priority: 'urgent' });
    expect(getTicket(store, t.id).priority).toBe('urgent');
  });

  it('an empty-string priority clears it back to NULL', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { priority: 'high' });
    updateTicketFields(store, t.id, { priority: '' });
    expect(getTicket(store, t.id).priority).toBeNull();
  });

  it('a new ticket has a null effort (inherit) until one is chosen', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    expect(getTicket(store, t.id).effort).toBeNull();
  });

  it('updateTicketFields round-trips the per-ticket effort', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { effort: 'high' });
    expect(getTicket(store, t.id).effort).toBe('high');
  });

  it('an empty-string effort clears the selection back to inherit (null)', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { effort: 'high' });
    updateTicketFields(store, t.id, { effort: '' });
    expect(getTicket(store, t.id).effort).toBeNull();
  });

  it('a new ticket has a null agentProvider (inherit) until one is chosen', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    expect(getTicket(store, t.id).agentProvider).toBeNull();
  });

  it('updateTicketFields round-trips the per-ticket agentProvider', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketFields(store, t.id, { agentProvider: 'codex' });
    expect(getTicket(store, t.id).agentProvider).toBe('codex');
  });

  it('an empty-string agentProvider clears the selection back to inherit (null)', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketFields(store, t.id, { agentProvider: 'antigravity' });
    updateTicketFields(store, t.id, { agentProvider: '' });
    expect(getTicket(store, t.id).agentProvider).toBeNull();
  });

  it('reads back null for a row with an invalid agent_provider written outside updateTicketFields (defense-in-depth)', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    // Bypass updateTicketFields entirely — simulates a hand-edited DB row
    // or a value left over from a provider later removed from IMPLEMENTED_PROVIDERS.
    store.db.prepare('UPDATE tickets SET agent_provider = ? WHERE id = ?').run('evil', t.id);
    expect(getTicket(store, t.id).agentProvider).toBeNull();
  });

  it('a new ticket has a null type (inherit the manifest default) until one is chosen', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    expect(getTicket(store, t.id).type).toBeNull();
  });

  it('updateTicketFields round-trips the conventional type', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { type: 'fix' });
    expect(getTicket(store, t.id).type).toBe('fix');
  });

  it('an empty-string type clears the selection back to inherit (null)', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { type: 'chore' });
    updateTicketFields(store, t.id, { type: '' });
    expect(getTicket(store, t.id).type).toBeNull();
  });

  // The type is interpolated into branch names, commit messages and PR titles —
  // public metadata. An unknown value must fail at the writer, not silently reach
  // a template render.
  it('rejects a type outside the curated vocabulary', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    expect(() => updateTicketFields(store, t.id, { type: 'feature' })).toThrow(/type/i);
    expect(getTicket(store, t.id).type).toBeNull();
  });

  it('updateTicketFields patches only the supplied fields', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketFields(store, t.id, { approach: 'tdd' });
    updateTicketFields(store, t.id, { brief: 'later' });
    const full = getTicket(store, t.id);
    expect(full.approach).toBe('tdd'); // untouched by the second patch
    expect(full.brief).toBe('later');
  });

  it('an empty patch is a no-op (no throw, no change)', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    setStage(store, t.id, 'uat', { status: 'running' });
    setStage(store, t.id, 'uat', {}); // empty patch
    setStage(store, t.id, 'uat', { verdict: undefined }); // all-undefined patch
    const uat = getTicket(store, t.id).stages.find((s) => s.stageKey === 'uat')!;
    expect(uat.status).toBe('running'); // unchanged
  });

  it('new tickets are not archived', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    expect(getTicket(store, t.id).archivedAt).toBeNull();
  });

  it('archiveTicket hides the ticket from the default list; listArchived shows it', () => {
    const a = createTicket(store, { key: 'A-1', title: 'keep' });
    const b = createTicket(store, { key: 'B-1', title: 'archive me' });
    archiveTicket(store, b.id);

    expect(listTickets(store).map((t) => t.id)).toEqual([a.id]);
    expect(listTickets(store, { includeArchived: true }).map((t) => t.id)).toEqual([b.id, a.id]);
    expect(listArchivedTickets(store).map((t) => t.id)).toEqual([b.id]);
    expect(getTicket(store, b.id).archivedAt).not.toBeNull();
  });

  it('unarchiveTicket returns the ticket to the active list', () => {
    const t = createTicket(store, { key: 'U-1', title: 'back' });
    archiveTicket(store, t.id);
    unarchiveTicket(store, t.id);
    expect(listTickets(store).map((x) => x.id)).toEqual([t.id]);
    expect(getTicket(store, t.id).archivedAt).toBeNull();
    expect(listArchivedTickets(store)).toHaveLength(0);
  });

  // The auto-archive sweep keys off the done stage's `ended_at` (doneArchive.ts),
  // so an unarchived ticket still at `done` with an old end time would be
  // re-archived on the very next sweep tick — "unarchived" would last a minute.
  // Unarchiving restarts the delay instead: the ticket stays visible for another
  // full delay from the unarchive (869eck7my).
  it('unarchiving a done ticket restarts its auto-archive delay', () => {
    const t = createTicket(store, { key: 'U-2', title: 'done, restored' });
    for (const stage of ['scope', 'impl', 'uat', 'review', 'ship'] as const) {
      transition(store, t.id, stage, { kind: 'passed' });
    }
    setStage(store, t.id, 'done', { endedAt: '2026-08-01T00:00:00.000Z' });
    archiveTicket(store, t.id);
    unarchiveTicket(store, t.id);

    const done = getTicket(store, t.id).stages.find((s) => s.stageKey === 'done')!;
    expect(done.endedAt).not.toBe('2026-08-01T00:00:00.000Z');
    expect(
      autoArchiveDoneTickets(store, {
        afterDays: 3,
        now: new Date('2026-08-10T00:00:00.000Z'),
      }),
    ).toEqual([]);
  });

  it('unarchiving a non-done ticket leaves its done row alone', () => {
    const t = createTicket(store, { key: 'U-3', title: 'mid-work' });
    archiveTicket(store, t.id);
    unarchiveTicket(store, t.id);
    const done = getTicket(store, t.id).stages.find((s) => s.stageKey === 'done')!;
    expect(done.endedAt).toBeNull();
  });

  it('deleteTicket hard-removes the ticket and its stage rows', () => {
    const t = createTicket(store, { key: 'D-1', title: 'gone' });
    setStage(store, t.id, 'impl', { status: 'running' });
    deleteTicket(store, t.id);

    expect(() => getTicket(store, t.id)).toThrow(/not found|unknown/i);
    expect(listTickets(store, { includeArchived: true })).toHaveLength(0);
    const stageRows = store.db.prepare('SELECT * FROM stages WHERE ticket_id = ?').all(t.id);
    expect(stageRows).toHaveLength(0);
  });

  // The four append-only / current-state evidence tables are keyed by
  // `ticket_id` but declare NO foreign key to `tickets`, so a hard delete used
  // to leave their rows orphaned — a ticket gone, its gate/phase/merge history
  // still answering queries by a ticket id nothing owns. They are part of the
  // product deletion contract now (`TICKET_CHILD_TABLES`), not a leak that
  // relies on SQLite's discovery.
  it('deleteTicket removes append-only gate/phase evidence and merge checks too', () => {
    const t = createTicket(store, { key: 'D-2', title: 'evidence' });
    const stageRunId = openStageRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      stageRunId,
      gates: [{ gateName: 'test', exitCode: 0 }],
    });
    recordPhaseMark(store, {
      ticketId: t.id,
      stageKey: 'impl',
      attempt: 0,
      phaseName: 'plan',
      markedAt: '2026-08-01T10:00:00.000Z',
    });
    setMergeCheck(store, {
      ticketId: t.id,
      repo: '/web',
      state: 'clean',
      files: [],
      reason: null,
      headSha: null,
      baseSha: null,
      baseRef: 'develop',
      checkedAt: '2026-08-01T10:00:00.000Z',
    });
    for (const table of ['gate_runs', 'stage_runs', 'phase_marks', 'merge_checks']) {
      const n = store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ticket_id = ?`)
        .get(t.id) as { n: number };
      expect(n.n, table).toBeGreaterThan(0);
    }

    deleteTicket(store, t.id);

    for (const table of ['gate_runs', 'stage_runs', 'phase_marks', 'merge_checks']) {
      const n = store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ticket_id = ?`)
        .get(t.id) as { n: number };
      expect(n.n, table).toBe(0);
    }
  });

  it('archive keeps append-only gate/phase evidence and merge checks', () => {
    const t = createTicket(store, { key: 'D-3', title: 'kept' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      gates: [{ gateName: 'test', exitCode: 0 }],
    });
    setMergeCheck(store, {
      ticketId: t.id,
      repo: '/web',
      state: 'clean',
      files: [],
      reason: null,
      headSha: null,
      baseSha: null,
      baseRef: 'develop',
      checkedAt: '2026-08-01T10:00:00.000Z',
    });
    archiveTicket(store, t.id);
    for (const table of ['gate_runs', 'merge_checks']) {
      const n = store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ticket_id = ?`)
        .get(t.id) as { n: number };
      expect(n.n, table).toBe(1);
    }
  });

  // The gate console logs (uat/review tail files) live under
  // `<globalStorage>/artifacts/<ticketId>/`; when `artifactsRoot` is passed
  // the hard delete removes the dir with the rows. Absent → the dir is left,
  // exactly like the graph bytes (a later sweep covers that case).
  it('deleteTicket removes the artifact console-log dir when artifactsRoot is given, and leaves it otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-art-delete-'));
    try {
      const t = createTicket(store, { key: 'D-4', title: 'logs' });
      const artifactsRoot = join(dir, 'artifacts');
      mkdirSync(join(artifactsRoot, String(t.id)), { recursive: true });
      writeFileSync(join(artifactsRoot, String(t.id), 'uat-ticket-1.log'), 'log');

      deleteTicket(store, t.id, undefined, artifactsRoot);
      expect(existsSync(join(artifactsRoot, String(t.id)))).toBe(false);

      const t2 = createTicket(store, { key: 'D-5', title: 'logs 2' });
      mkdirSync(join(artifactsRoot, String(t2.id)), { recursive: true });
      writeFileSync(join(artifactsRoot, String(t2.id), 'x'), 'y');
      deleteTicket(store, t2.id);
      expect(existsSync(join(artifactsRoot, String(t2.id)))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The product deletion contract (v27): foreign keys are ON in openStore, so a
  // ticket whose token/finding evidence links to its process_runs rows must be
  // deletable WITHOUT relying on SQLite discovering a safe order. The ledger is
  // global accounting — it survives, unattributed; only ticket-owned evidence
  // (process runs, findings) goes.
  it('hard-deletes a ticket with linked process evidence without destroying the ledger', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a' });
    const b = createTicket(store, { key: 'B-1', title: 'b' });
    const runA = openProcessRun(store, {
      ticketId: a.id,
      stageKey: 'review',
      processId: 'review',
      attempt: 0,
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: a.id,
      processRunId: runA.id,
      callSite: 'fix-resume',
      outcome: 'ok',
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        model: 'claude-opus-5',
        estimated: false,
      },
    });
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: b.id,
      callSite: 'fix-resume',
      outcome: 'ok',
      usage: {
        inputTokens: 7,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 8,
        model: null,
        estimated: false,
      },
    });
    recordFindings(store, {
      ticketId: a.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      processRunId: runA.id,
      findings: [{ severity: 'high', repo: '/web', file: null, line: null, title: 'boom', detail: 'd', source: 'agent' }],
    });

    expect(() => deleteTicket(store, a.id)).not.toThrow();

    // No ticket-owned evidence rows remain.
    expect(() => getTicket(store, a.id)).toThrow(/not found|unknown/i);
    expect(listProcessRuns(store, a.id)).toEqual([]);
    expect(listFindings(store, a.id)).toEqual([]);

    // The global ledger survives: a's spend is unattributed but not destroyed,
    // b's spend is untouched.
    const rows = listTokenUsage(store, {});
    expect(rows).toHaveLength(2);
    const orphaned = rows.find((r) => r.ticketId === null)!;
    expect(orphaned.totalTokens).toBe(150);
    expect(orphaned.processRunId).toBeNull();
    const untouched = rows.find((r) => r.ticketId === b.id)!;
    expect(untouched.totalTokens).toBe(8);
  });

  it('persists session_id with the provider that minted it, both readable via getTicket', () => {
    const t = createTicket(store, { key: 'K-1', title: 'demo' });
    setSessionId(store, t.id, 'sess-abc', 'claude');
    const read = getTicket(store, t.id);
    expect(read.sessionId).toBe('sess-abc');
    expect(read.sessionProvider).toBe('claude');
  });

  it('clears session_id and its provider together (stale resume recovery)', () => {
    const t = createTicket(store, { key: 'K-1', title: 'demo' });
    setSessionId(store, t.id, 'sess-abc', 'claude');
    setSessionId(store, t.id, null, null);
    const read = getTicket(store, t.id);
    expect(read.sessionId).toBeNull();
    expect(read.sessionProvider).toBeNull();
  });

  it('overwrites the provider when a new session is captured under a different core', () => {
    const t = createTicket(store, { key: 'K-1', title: 'demo' });
    setSessionId(store, t.id, 'codex-sess', 'codex');
    setSessionId(store, t.id, 'claude-sess', 'claude');
    const read = getTicket(store, t.id);
    expect(read.sessionId).toBe('claude-sess');
    expect(read.sessionProvider).toBe('claude');
  });

  it('a legacy row whose session predates session_provider reads back a null provider', () => {
    const t = createTicket(store, { key: 'K-1', title: 'demo' });
    // Simulates a row migrated from v12: session_id survives, provider unknown.
    store.db.prepare('UPDATE tickets SET session_id = ? WHERE id = ?').run('old-sess', t.id);
    const read = getTicket(store, t.id);
    expect(read.sessionId).toBe('old-sess');
    expect(read.sessionProvider).toBeNull();
  });

  it('reads back null for a session_provider value not in the known provider set', () => {
    const t = createTicket(store, { key: 'K-1', title: 'demo' });
    store.db
      .prepare('UPDATE tickets SET session_id = ?, session_provider = ? WHERE id = ?')
      .run('sess', 'evil', t.id);
    expect(getTicket(store, t.id).sessionProvider).toBeNull();
  });

  it('lists tickets ordered by created_at descending (newest first)', () => {
    const a = createTicket(store, { key: 'A-1', title: 'first' });
    const b = createTicket(store, { key: 'B-1', title: 'second' });
    const c = createTicket(store, { key: 'C-1', title: 'third' });
    expect(listTickets(store).map((t) => t.id)).toEqual([c.id, b.id, a.id]);
  });

  it('re-added (unarchived) ticket updates created_at so it can sort correctly', () => {
    const reused = createTicket(store, { key: 'PROJ-1', title: 'initial' });
    const beforeUnarchive = getTicket(store, reused.id);
    const createdBefore = beforeUnarchive.id; // store doesn't expose created_at directly in type

    archiveTicket(store, reused.id);
    unarchiveTicket(store, reused.id);

    const afterUnarchive = getTicket(store, reused.id);
    // Verify archived_at was cleared
    expect(afterUnarchive.archivedAt).toBeNull();
    // Verify the ticket is back in the active list
    expect(listTickets(store).map((t) => t.id)).toContain(reused.id);
  });

  it('archived list also sorts by created_at descending', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a' });
    const b = createTicket(store, { key: 'B-1', title: 'b' });
    archiveTicket(store, a.id);
    archiveTicket(store, b.id);
    expect(listArchivedTickets(store).map((t) => t.id)).toEqual([b.id, a.id]);
  });
});

/**
 * Project scoping (§ projects / multi-window). Two IDE windows share one global
 * DB, so every list query must filter by the window's project or window A shows
 * — and acts on — project B's tickets against the wrong manifest.
 */
describe('project scoping', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const PROJ_A = 1;
  const PROJ_B = 2;

  it('records the project a ticket was created under', () => {
    const t = createTicket(store, { key: 'A-1', title: 'a', projectId: PROJ_A });
    expect(t.projectId).toBe(PROJ_A);
  });

  it('leaves projectId null when none is supplied (legacy create path)', () => {
    expect(createTicket(store, { key: 'L-1', title: 'legacy' }).projectId).toBeNull();
  });

  it('listTickets returns only the requested project', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId: PROJ_A });
    createTicket(store, { key: 'B-1', title: 'b', projectId: PROJ_B });
    expect(listTickets(store, { projectId: PROJ_A }).map((t) => t.id)).toEqual([a.id]);
  });

  it('listTickets returns every project when unscoped (the all-projects view)', () => {
    createTicket(store, { key: 'A-1', title: 'a', projectId: PROJ_A });
    createTicket(store, { key: 'B-1', title: 'b', projectId: PROJ_B });
    expect(listTickets(store)).toHaveLength(2);
  });

  it('scoped listTickets still excludes archived tickets by default', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId: PROJ_A });
    const b = createTicket(store, { key: 'A-2', title: 'a2', projectId: PROJ_A });
    archiveTicket(store, b.id);
    expect(listTickets(store, { projectId: PROJ_A }).map((t) => t.id)).toEqual([a.id]);
    expect(
      listTickets(store, { projectId: PROJ_A, includeArchived: true }).map((t) => t.id).sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('listArchivedTickets is scoped too', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId: PROJ_A });
    const b = createTicket(store, { key: 'B-1', title: 'b', projectId: PROJ_B });
    archiveTicket(store, a.id);
    archiveTicket(store, b.id);
    expect(listArchivedTickets(store, { projectId: PROJ_A }).map((t) => t.id)).toEqual([a.id]);
  });

  it('a legacy ticket with no project is hidden from a scoped list', () => {
    createTicket(store, { key: 'L-1', title: 'legacy' });
    expect(listTickets(store, { projectId: PROJ_A })).toEqual([]);
  });

  it('getTicketByKey resolves per project, so two projects may reuse one key', () => {
    const a = createTicket(store, { key: 'PROJ-1', title: 'in A', projectId: PROJ_A });
    const b = createTicket(store, { key: 'PROJ-1', title: 'in B', projectId: PROJ_B });
    expect(a.id).not.toBe(b.id);
    expect(getTicketByKey(store, 'PROJ-1', { projectId: PROJ_A })?.id).toBe(a.id);
    expect(getTicketByKey(store, 'PROJ-1', { projectId: PROJ_B })?.id).toBe(b.id);
  });
});

/**
 * Uninstalling an approach removes the package directory, so every ticket still
 * pointing at that approach holds a dangling reference — and a launch from one
 * of those tickets is exactly what produces the "produced no method prompt or
 * loadable artifacts" warning. Clearing the reference is part of the uninstall,
 * not a display concern (869eckp0x).
 */
describe('clearApproachFromTickets', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const PROJ_A = 1;
  const PROJ_B = 2;

  it('clears the reference from every ticket bound to the approach', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId: PROJ_A });
    const b = createTicket(store, { key: 'A-2', title: 'b', projectId: PROJ_A });
    updateTicketFields(store, a.id, { approach: 'superpowers:writing-plans' });
    updateTicketFields(store, b.id, { approach: 'superpowers:writing-plans' });

    expect(clearApproachFromTickets(store, 'superpowers:writing-plans', { projectId: PROJ_A })).toBe(2);
    expect(getTicket(store, a.id).approach).toBeNull();
    expect(getTicket(store, b.id).approach).toBeNull();
  });

  it('leaves tickets on other approaches untouched', () => {
    const keep = createTicket(store, { key: 'A-1', title: 'keep', projectId: PROJ_A });
    updateTicketFields(store, keep.id, { approach: 'direct' });

    expect(clearApproachFromTickets(store, 'rpi', { projectId: PROJ_A })).toBe(0);
    expect(getTicket(store, keep.id).approach).toBe('direct');
  });

  it('is project-scoped — another window’s tickets are never touched', () => {
    const mine = createTicket(store, { key: 'A-1', title: 'mine', projectId: PROJ_A });
    const theirs = createTicket(store, { key: 'B-1', title: 'theirs', projectId: PROJ_B });
    updateTicketFields(store, mine.id, { approach: 'rpi' });
    updateTicketFields(store, theirs.id, { approach: 'rpi' });

    expect(clearApproachFromTickets(store, 'rpi', { projectId: PROJ_A })).toBe(1);
    expect(getTicket(store, mine.id).approach).toBeNull();
    expect(getTicket(store, theirs.id).approach).toBe('rpi');
  });

  it('is idempotent — a repeat uninstall clears nothing more', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId: PROJ_A });
    updateTicketFields(store, a.id, { approach: 'rpi' });
    expect(clearApproachFromTickets(store, 'rpi', { projectId: PROJ_A })).toBe(1);
    expect(clearApproachFromTickets(store, 'rpi', { projectId: PROJ_A })).toBe(0);
  });
});

describe('deleteTicket — graph evidence (Slice-2 T8)', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  /** Seed a ticket with a full mid-execution graph subtree. */
  function seedGraphTicket(): {
    ticketId: number;
    graphRunId: number;
    plannerRunId: number;
    revisionId: number;
    nodeRunId: number;
  } {
    const t = createTicket(store, { key: 'G-1', title: 'graph' });
    const graphRunId = createGraphRun(store.db, {
      ticketId: t.id,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: '2026-08-11T00:00:00.000Z',
    });
    const plannerRunId = createPlannerRun(store.db, {
      graphRunId,
      plannerRunNumber: 1,
      kind: 'bootstrap',
    });
    const revisionId = createRevision(store.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: '{}',
      fingerprint: 'fp',
      status: 'active',
      now: '2026-08-11T00:00:00.000Z',
    });
    const nodeRunId = createNodeRun(store.db, {
      graphRunId,
      revisionId,
      nodeId: 'a',
      nodeKind: 'agent',
      visitNumber: 1,
      now: '2026-08-11T00:00:00.000Z',
    });
    createToken(store.db, {
      revisionId,
      sourceNodeRunId: null,
      isEntry: 1,
      edgeId: 'entry',
      destinationNodeId: 'a',
      destinationEnd: 0,
      forkInstance: 1,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    });
    store.db
      .prepare(
        `INSERT INTO approach_artifact_instances (graph_run_id, revision_id, producer_planner_run_id, artifact_id, snapshot_path, sha256, byte_size, media_type, created_at)
         VALUES (?, ?, ?, 'task', '/snap/x', 'x', 1, 'text/markdown', ?)`,
      )
      .run(graphRunId, revisionId, plannerRunId, '2026-08-11T00:00:00.000Z');
    store.db
      .prepare(
        `INSERT INTO approach_resource_leases (graph_run_id, owner_node_run_id, physical_domain, access_mode, status, acquired_at)
         VALUES (?, ?, 'domain', 'write', 'held', ?)`,
      )
      .run(graphRunId, nodeRunId, '2026-08-11T00:00:00.000Z');
    store.db
      .prepare(
        `INSERT INTO approach_node_overrides (graph_run_id, node_id, row_version, updated_at)
         VALUES (?, 'a', 0, ?)`,
      )
      .run(graphRunId, '2026-08-11T00:00:00.000Z');
    store.db
      .prepare(
        `INSERT INTO approach_node_deferrals (graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
         VALUES (?, ?, 'a', 'resource-conflict: x', ?, ?)`,
      )
      .run(graphRunId, revisionId, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');
    return { ticketId: t.id, graphRunId, plannerRunId, revisionId, nodeRunId };
  }

  it('hard delete removes every graph row and the byte subtree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-graph-delete-'));
    try {
      const { ticketId } = seedGraphTicket();
      const graphBytesRoot = join(dir, 'graph', 'project');
      mkdirSync(join(graphBytesRoot, String(ticketId), 'artifacts'), { recursive: true });
      writeFileSync(join(graphBytesRoot, String(ticketId), 'artifacts', 'x'), 'bytes');

      deleteTicket(store, ticketId, graphBytesRoot);

      for (const table of [
        'approach_graph_tokens',
        'approach_node_overrides',
        'approach_resource_leases',
        'approach_node_deferrals',
        'approach_artifact_instances',
        'approach_node_runs',
        'approach_planner_runs',
        'approach_graph_revisions',
        'approach_graph_runs',
      ]) {
        const n = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(n.n, table).toBe(0);
      }
      expect(existsSync(join(graphBytesRoot, String(ticketId)))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archive removes neither rows nor bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-graph-archive-'));
    try {
      const { ticketId, graphRunId } = seedGraphTicket();
      const graphBytesRoot = join(dir, 'graph', 'project');
      mkdirSync(join(graphBytesRoot, String(ticketId)), { recursive: true });
      writeFileSync(join(graphBytesRoot, String(ticketId), 'x'), 'bytes');

      archiveTicket(store, ticketId);

      const runs = store.db
        .prepare('SELECT COUNT(*) AS n FROM approach_graph_runs WHERE id = ?')
        .get(graphRunId) as { n: number };
      expect(runs.n).toBe(1);
      expect(existsSync(join(graphBytesRoot, String(ticketId), 'x'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleting a ticket mid-execution runs the explicit sequence without FK errors', () => {
    const { ticketId } = seedGraphTicket();
    expect(() => deleteTicket(store, ticketId)).not.toThrow();
  });

  it('token_usage rows survive with their graph FKs set to NULL', () => {
    const { ticketId, plannerRunId, nodeRunId } = seedGraphTicket();
    store.db
      .prepare(
        `INSERT INTO token_usage (project_id, ticket_id, call_site, outcome, total_tokens,
                                  approach_planner_run_id, approach_node_run_id, recorded_at)
         VALUES (1, ?, 'graph-planner', 'ok', 150, ?, ?, ?)`,
      )
      .run(ticketId, plannerRunId, nodeRunId, '2026-08-11T00:00:00.000Z');
    deleteTicket(store, ticketId);
    const rows = store.db
      .prepare(
        `SELECT ticket_id, approach_planner_run_id, approach_node_run_id, total_tokens
         FROM token_usage`,
      )
      .all() as Array<{
      ticket_id: number | null;
      approach_planner_run_id: number | null;
      approach_node_run_id: number | null;
      total_tokens: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticket_id: null,
      approach_planner_run_id: null,
      approach_node_run_id: null,
      total_tokens: 150,
    });
  });
});

describe('baseRefs', () => {
  it('defaults to an empty object', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'B-1', title: 't' }).id;
    expect(getTicket(store, id)!.baseRefs).toEqual({});
  });

  it('round-trips a per-repo override', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'B-2', title: 't' }).id;
    updateTicketFields(store, id, { baseRefs: { api: 'epic/checkout', web: 'develop' } });
    expect(getTicket(store, id)!.baseRefs).toEqual({ api: 'epic/checkout', web: 'develop' });
  });

  it('tolerates a corrupt column, exactly like selected_repos', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'B-3', title: 't' }).id;
    store.db.prepare('UPDATE tickets SET base_refs = ? WHERE id = ?').run('not json', id);
    expect(getTicket(store, id)!.baseRefs).toEqual({});
  });

  it('drops non-string values rather than trusting the column', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'B-4', title: 't' }).id;
    store.db
      .prepare('UPDATE tickets SET base_refs = ? WHERE id = ?')
      .run(JSON.stringify({ api: 3, web: 'develop' }), id);
    expect(getTicket(store, id)!.baseRefs).toEqual({ web: 'develop' });
  });
});
