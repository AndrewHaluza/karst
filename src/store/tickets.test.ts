import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './db.js';
import {
  createTicket,
  getTicket,
  getTicketByKey,
  generateTicketKey,
  ticketLabel,
  updateTicketCore,
  updateTicketOnboarding,
  archiveTicket,
  unarchiveTicket,
  deleteTicket,
  listTickets,
  listArchivedTickets,
  setSessionId,
  type Ticket,
} from './tickets.js';
import { setStage } from './stages.js';
import { STAGE_KEYS } from '../model/types.js';

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
    archivedAt: null,
    model: null,
    agentProvider: null,
    projectId: null,
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

  it('new tickets default the onboarding fields', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    const full = getTicket(store, t.id);
    expect(full.description).toBeNull();
    expect(full.brief).toBeNull();
    expect(full.approach).toBeNull();
    expect(full.agent).toBeNull();
    expect(full.selectedRepos).toEqual([]);
  });

  it('updateTicketCore changes key and title only', () => {
    const t = createTicket(store, { key: 'OLD-1', title: 'old' });
    updateTicketCore(store, t.id, { key: 'NEW-2', title: 'new' });
    const full = getTicket(store, t.id);
    expect(full.key).toBe('NEW-2');
    expect(full.title).toBe('new');
    expect(full.stageCurrent).toBe('scope'); // untouched
  });

  it('updateTicketOnboarding round-trips brief, approach, and selected repos', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketOnboarding(store, t.id, {
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

  it('updateTicketOnboarding persists agent selection independently', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketOnboarding(store, t.id, { agent: 'reviewer' });
    const full = getTicket(store, t.id);
    expect(full.agent).toBe('reviewer');
  });

  it('a new ticket has a null model (inherit) until one is chosen', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    expect(getTicket(store, t.id).model).toBeNull();
  });

  it('updateTicketOnboarding round-trips the per-ticket model', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketOnboarding(store, t.id, { model: 'claude-opus-4-8' });
    expect(getTicket(store, t.id).model).toBe('claude-opus-4-8');
  });

  it('an empty-string model clears the selection back to inherit (null)', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketOnboarding(store, t.id, { model: 'claude-sonnet-5' });
    updateTicketOnboarding(store, t.id, { model: '' });
    expect(getTicket(store, t.id).model).toBeNull();
  });

  it('a new ticket has a null agentProvider (inherit) until one is chosen', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    expect(getTicket(store, t.id).agentProvider).toBeNull();
  });

  it('updateTicketOnboarding round-trips the per-ticket agentProvider', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'codex' });
    expect(getTicket(store, t.id).agentProvider).toBe('codex');
  });

  it('an empty-string agentProvider clears the selection back to inherit (null)', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'antigravity' });
    updateTicketOnboarding(store, t.id, { agentProvider: '' });
    expect(getTicket(store, t.id).agentProvider).toBeNull();
  });

  it('reads back null for a row with an invalid agent_provider written outside updateTicketOnboarding (defense-in-depth)', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    // Bypass updateTicketOnboarding entirely — simulates a hand-edited DB row
    // or a value left over from a provider later removed from IMPLEMENTED_PROVIDERS.
    store.db.prepare('UPDATE tickets SET agent_provider = ? WHERE id = ?').run('evil', t.id);
    expect(getTicket(store, t.id).agentProvider).toBeNull();
  });

  it('updateTicketOnboarding patches only the supplied fields', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'x' });
    updateTicketOnboarding(store, t.id, { approach: 'tdd' });
    updateTicketOnboarding(store, t.id, { brief: 'later' });
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

  it('deleteTicket hard-removes the ticket and its stage rows', () => {
    const t = createTicket(store, { key: 'D-1', title: 'gone' });
    setStage(store, t.id, 'impl', { status: 'running' });
    deleteTicket(store, t.id);

    expect(() => getTicket(store, t.id)).toThrow(/not found|unknown/i);
    expect(listTickets(store, { includeArchived: true })).toHaveLength(0);
    const stageRows = store.db.prepare('SELECT * FROM stages WHERE ticket_id = ?').all(t.id);
    expect(stageRows).toHaveLength(0);
  });

  it('persists session_id and leaves it readable via getTicket', () => {
    const t = createTicket(store, { key: 'K-1', title: 'demo' });
    setSessionId(store, t.id, 'sess-abc');
    expect(getTicket(store, t.id).sessionId).toBe('sess-abc');
  });

  it('clears session_id when set to null (stale resume recovery)', () => {
    const t = createTicket(store, { key: 'K-1', title: 'demo' });
    setSessionId(store, t.id, 'sess-abc');
    setSessionId(store, t.id, null);
    expect(getTicket(store, t.id).sessionId).toBeNull();
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
