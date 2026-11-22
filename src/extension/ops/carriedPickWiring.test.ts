import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { listEvents } from '../../store/karstEvents.js';
import { upsertProject } from '../../store/projects.js';
import { makeCarriedPickWiring } from './carriedPickWiring.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import type { Manifest } from '../../manifest/types.js';

describe('makeCarriedPickWiring (T1313, @arch:AC-65)', () => {
  const now = new Date('2026-11-22T12:00:00.000Z');
  const base = { manifest: () => ({ repositories: [] }) as unknown as Manifest, catalog: () => bundledModelCatalog() };

  it('reads the lane provider from the ticket pick without an adapter', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'T-LP', title: 't' });
    store.db.prepare("UPDATE tickets SET agent_provider = 'codex' WHERE id = ?").run(t.id);
    const w = makeCarriedPickWiring({ store, fallbackProjectId: () => 1, quotaFor: () => undefined, debug: vi.fn(), ...base });
    expect(w.laneProvider(t.id, 'review')).toBe('codex');
  });

  it('records one host Activity entry in the ticket project', () => {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const t = createTicket(store, { key: 'T-ACT', title: 't', projectId: project.id });
    const w = makeCarriedPickWiring({ store, fallbackProjectId: () => undefined, quotaFor: () => undefined, debug: vi.fn(), now: () => now, ...base });
    w.carryActivity(t.id, 'used claude/claude-opus-5-5 from the usage-limit pick until 15:05');
    expect(listEvents(store, { projectId: project.id, limit: 10 })).toEqual([
      expect.objectContaining({ ticketId: t.id, level: 'info', source: 'host', title: 'used claude/claude-opus-5-5 from the usage-limit pick until 15:05' }),
    ]);
  });

  it('skips with a debug line when no project or no ticket is known', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'T-NOPROJ', title: 't' });
    const debug = vi.fn();
    const w = makeCarriedPickWiring({ store, fallbackProjectId: () => undefined, quotaFor: () => undefined, debug, ...base });
    w.carryActivity(t.id, 'x');
    w.carryActivity(9999, 'x');
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it('reads the quota reset for a known core only', () => {
    const store = openStore(':memory:');
    const quotaFor = vi.fn(() => ({
      core: 'claude' as const, state: 'ok' as const, source: 't', readAt: now.toISOString(),
      windows: [{ label: '5-hour', usedPct: 100, resetsAt: '2026-11-22T13:00:00.000Z' }],
    }));
    const w = makeCarriedPickWiring({ store, fallbackProjectId: () => 1, quotaFor, debug: vi.fn(), now: () => now, ...base });
    expect(w.quotaResetFor('claude')).toBe('2026-11-22T13:00:00.000Z');
    expect(w.quotaResetFor('nope')).toBeNull();
    expect(quotaFor).toHaveBeenCalledTimes(1);
  });
});
