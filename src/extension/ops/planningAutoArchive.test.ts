import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket } from '../../store/tickets.js';
import {
  createPlanningSession,
  getPlanningSession,
  setPlanningSessionStatus,
} from '../../store/planningSessions.js';
import { insertProposal, markProposalAccepted, discardProposal } from '../../store/planningProposals.js';
import { autoArchivePlanningSessions, sweepPlanningArchive } from './planningAutoArchive.js';

const payload = { title: 'T', description: 'd', summary: 's', repos: ['api'] };
const NOW = new Date('2026-10-24T12:00:00Z');
const OLD = '2026-10-20 12:00:00'; // 4 days idle
const FRESH = '2026-10-22 12:00:01'; // just under 3 days idle

describe('autoArchivePlanningSessions', () => {
  let store: Store;
  let projectId: number;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  const touch = (id: number, at: string): void => {
    store.db.prepare('UPDATE planning_sessions SET updated_at = ? WHERE id = ?').run(at, id);
  };
  const stamp = (proposalId: number, at: string): void => {
    store.db.prepare('UPDATE planning_proposals SET updated_at = ? WHERE id = ?').run(at, proposalId);
  };
  const session = (at = OLD, pid = projectId): number => {
    const id = createPlanningSession(store, { projectId: pid, title: 's', core: 'claude', model: null }).id;
    touch(id, at);
    return id;
  };
  const accepted = (sessionId: number, at = OLD): number => {
    const pid = insertProposal(store, sessionId, payload);
    const t = createTicket(store, { projectId, title: 'x' } as never);
    markProposalAccepted(store, pid, t.id);
    stamp(pid, at);
    touch(sessionId, at);
    return pid;
  };
  const run = (isLive: (id: number) => boolean = () => false, afterDays = 3) =>
    autoArchivePlanningSessions({ store, projectId, afterDays, now: NOW, isLive });
  const status = (id: number) => getPlanningSession(store, id)!.status;

  it('archives a session whose drafts are all accepted after the idle delay', () => {
    const id = session();
    accepted(id);
    expect(run()).toEqual([id]);
    expect(status(id)).toBe('archived');
  });

  it('archives a filed session with no pending drafts', () => {
    const id = session();
    setPlanningSessionStatus(store, id, 'filed');
    touch(id, OLD);
    expect(run()).toEqual([id]);
  });

  it('ignores discarded drafts when judging finished', () => {
    const id = session();
    accepted(id);
    const d = insertProposal(store, id, payload);
    discardProposal(store, d);
    stamp(d, OLD);
    expect(run()).toEqual([id]);
  });

  it('keeps a session with a pending draft', () => {
    const id = session();
    accepted(id);
    stamp(insertProposal(store, id, payload), OLD);
    expect(run()).toEqual([]);
    expect(status(id)).not.toBe('archived');
  });

  it('keeps an active session with no drafts, and one whose only draft was discarded', () => {
    const id = session();
    const other = session();
    const d = insertProposal(store, other, payload);
    discardProposal(store, d);
    stamp(d, OLD);
    expect(run()).toEqual([]);
    expect(status(id)).toBe('active');
  });

  it('keeps a live session', () => {
    const id = session();
    accepted(id);
    expect(run((s) => s === id)).toEqual([]);
  });

  it('measures idleness from the newest of the session and its drafts', () => {
    const id = session();
    const pid = accepted(id);
    touch(id, FRESH);
    expect(run()).toEqual([]);
    touch(id, OLD);
    stamp(pid, FRESH);
    expect(run()).toEqual([]);
  });

  it('archives exactly at the cutoff', () => {
    const id = session();
    accepted(id, '2026-10-21 12:00:00');
    expect(run()).toEqual([id]);
  });

  it('honours afterDays', () => {
    const id = session();
    accepted(id);
    expect(run(() => false, 5)).toEqual([]);
    expect(run(() => false, 4)).toEqual([id]);
  });

  it('sweepPlanningArchive uses the manifest delay, defaulting to 3 days', () => {
    const id = session('2000-01-01 00:00:00');
    accepted(id, '2000-01-01 00:00:00');
    const logError = vi.fn();
    const deps = { store, projectId, isLive: () => false, logError };
    expect(sweepPlanningArchive({ ...deps, manifest: { archivePlanningAfterDays: 100000 } })).toEqual([]);
    expect(sweepPlanningArchive({ ...deps, manifest: undefined })).toEqual([id]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('sweepPlanningArchive default is 3 days, not more or less', () => {
    const id = session('2026-10-24 11:00:00');
    accepted(id, '2026-10-24 11:00:00');
    expect(sweepPlanningArchive({ store, projectId, isLive: () => false, logError: vi.fn(), manifest: undefined })).toEqual([]);
  });

  it('sweepPlanningArchive reports a failure instead of throwing', () => {
    const logError = vi.fn();
    store.close();
    expect(sweepPlanningArchive({ store, projectId, manifest: undefined, logError, isLive: () => false })).toEqual([]);
    expect(logError).toHaveBeenCalledWith('karst: planning session auto-archive failed', expect.anything());
    store = openStore(':memory:');
  });

  it('leaves other projects alone and is idempotent', () => {
    const other = upsertProject(store, { slug: 'q' }).id;
    const o = session(OLD, other);
    setPlanningSessionStatus(store, o, 'filed');
    touch(o, OLD);
    const id = session();
    accepted(id);
    expect(run()).toEqual([id]);
    expect(run()).toEqual([]);
    expect(status(o)).toBe('filed');
  });
});
