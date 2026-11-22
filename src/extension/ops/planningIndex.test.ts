import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession } from '../../store/planningSessions.js';
import { insertProposal } from '../../store/planningProposals.js';
import { readOutboxRejection, readProposalIndex } from '../../planning/proposalIndex.js';
import { recordOutboxRejection, refreshProposalIndex } from './planningIndex.js';

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = { title: 'Fix auth', description: 'd', summary: 's', repos: ['api'] };

describe('refreshProposalIndex', () => {
  let store: Store;
  let sessionId: number;
  let scratch: string;
  beforeEach(() => {
    store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: null }).id;
    scratch = mkdtempSync(join(tmpdir(), 'karst-plan-index-'));
  });
  afterEach(() => {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const byId = () => new Map(readProposalIndex(scratch).map((e) => [e.id, e]));

  it('writes warnings only for a draft that has some', () => {
    const a = insertProposal(store, sessionId, payload, UUID(1), ['unknown design key @arch:NOPE']);
    const b = insertProposal(store, sessionId, payload, UUID(2));
    refreshProposalIndex(store, sessionId, scratch);
    expect(byId().get(a)!.warnings).toEqual(['unknown design key @arch:NOPE']);
    expect('warnings' in byId().get(b)!).toBe(false);
  });

  it('marks checking: true only for the ids in checkingIds', () => {
    const a = insertProposal(store, sessionId, payload, UUID(1));
    const b = insertProposal(store, sessionId, payload, UUID(2));
    refreshProposalIndex(store, sessionId, scratch, { checkingIds: new Set([a]) });
    expect(byId().get(a)!.checking).toBe(true);
    expect('checking' in byId().get(b)!).toBe(false);
    refreshProposalIndex(store, sessionId, scratch);
    expect('checking' in byId().get(a)!).toBe(false);
  });
});

describe('injected fs', () => {
  it('refreshProposalIndex writes through opts.fs', () => {
    const store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    const sid = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: null }).id;
    const scratch = mkdtempSync(join(tmpdir(), 'karst-plan-index-fs-'));
    const renameSync = vi.fn(nodeFs.renameSync);
    try {
      insertProposal(store, sid, payload, UUID(1));
      refreshProposalIndex(store, sid, scratch, { fs: { ...nodeFs, renameSync } as typeof nodeFs });
      expect(renameSync).toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('recordOutboxRejection writes through opts.fs', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'karst-plan-reject-fs-'));
    const renameSync = vi.fn(nodeFs.renameSync);
    try {
      recordOutboxRejection(scratch, UUID(4), 'r', 0, { fs: { ...nodeFs, renameSync } as typeof nodeFs });
      expect(renameSync).toHaveBeenCalled();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('recordOutboxRejection', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-plan-reject-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('writes the reason with an ISO timestamp that the CLI reads', () => {
    recordOutboxRejection(scratch, UUID(3), 'unknown repositories x', Date.UTC(2026, 10, 22));
    expect(readOutboxRejection(scratch, UUID(3))).toEqual({
      uuid: UUID(3),
      reason: 'unknown repositories x',
      rejectedAt: '2026-11-22T00:00:00.000Z',
    });
  });
});
