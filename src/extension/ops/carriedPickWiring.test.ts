import { describe, it, expect, vi } from 'vitest';

const resolveSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../agent/processAssignment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/processAssignment.js')>();
  return {
    ...actual,
    resolveProcessAssignment: (...args: Parameters<typeof actual.resolveProcessAssignment>) => {
      resolveSpy.calls.push(args);
      return actual.resolveProcessAssignment(...args);
    },
  };
});

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

  it('hands the ticket picks to the role resolver, blank values as undefined', () => {
    const store = openStore(':memory:');
    const full = createTicket(store, { key: 'T-PK1', title: 't' });
    store.db
      .prepare("UPDATE tickets SET agent_provider = 'codex', model = 'gpt-4o', effort = 'high', agent_preset = 'fast' WHERE id = ?")
      .run(full.id);
    const blank = createTicket(store, { key: 'T-PK2', title: 't' });
    store.db.prepare("UPDATE tickets SET model = '', effort = '' WHERE id = ?").run(blank.id);
    const w = makeCarriedPickWiring({ store, fallbackProjectId: () => 1, quotaFor: () => undefined, debug: vi.fn(), ...base });

    resolveSpy.calls.length = 0;
    w.laneProvider(full.id, 'review');
    expect(resolveSpy.calls[0]![1]).toBe('review');
    expect(resolveSpy.calls[0]![2]).toEqual({ provider: 'codex', model: 'gpt-4o', effort: 'high', preset: 'fast' });

    resolveSpy.calls.length = 0;
    w.laneProvider(blank.id, 'review');
    expect(resolveSpy.calls[0]![2]).toStrictEqual({ provider: undefined, model: undefined, effort: undefined, preset: undefined });
  });

  it('gives null as the lane provider when the role is disabled', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'T-OFF', title: 't' });
    const disabled = { processes: { review: { enabled: false } }, repositories: [] } as unknown as Manifest;
    const w = makeCarriedPickWiring({ store, fallbackProjectId: () => 1, quotaFor: () => undefined, debug: vi.fn(), manifest: () => disabled, catalog: () => bundledModelCatalog() });
    expect(w.laneProvider(t.id, 'review')).toBeNull();
  });

  it('names the reason in the debug line for each skipped Activity entry', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'T-MSG', title: 't' });
    const debug = vi.fn();
    const w = makeCarriedPickWiring({ store, fallbackProjectId: () => undefined, quotaFor: () => undefined, debug, ...base });
    w.carryActivity(t.id, 'the title');
    expect(debug).toHaveBeenLastCalledWith(`[driver] ticket ${t.id}: no project for the carried-pick Activity entry (the title)`);
    w.carryActivity(9999, 'x');
    expect(debug.mock.calls[1]![0]).toMatch(/^\[driver\] ticket 9999: carried-pick Activity skipped: .+/);
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it('uses the wall clock for the quota reset when no clock is injected', () => {
    const store = openStore(':memory:');
    const quotaFor = () => ({
      core: 'claude' as const, state: 'ok' as const, source: 't', readAt: now.toISOString(),
      windows: [{ label: '5-hour', usedPct: 100, resetsAt: '2999-01-01T00:00:00.000Z' }],
    });
    const w = makeCarriedPickWiring({ store, fallbackProjectId: () => 1, quotaFor, debug: vi.fn(), ...base });
    expect(w.quotaResetFor('claude')).toBe('2999-01-01T00:00:00.000Z');
  });
});
