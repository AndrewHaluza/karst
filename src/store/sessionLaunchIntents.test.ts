import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import { listImplementationTimeline } from './implementationRuns.js';
import {
  recordSessionLaunchIntent,
  confirmSessionLaunchIntent,
  failSessionLaunchIntent,
  supersedePendingLaunchIntents,
  getSessionLaunchIntent,
  type SessionLaunchIntent,
} from './sessionLaunchIntents.js';

describe('session launch intents', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
  });
  afterEach(() => store.close());

  function record(
    launchId: string,
    overrides: Partial<Parameters<typeof recordSessionLaunchIntent>[1]> = {},
  ): SessionLaunchIntent {
    return recordSessionLaunchIntent(store, {
      ticketId,
      launchId,
      purpose: 'implementation',
      provider: 'claude',
      model: 'opus',
      reason: 'initial',
      sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
      ...overrides,
    });
  }

  it('opens the stable implementation run on the first implementation launch', () => {
    const intent = record('l1');
    expect(intent.implementationRunId).not.toBeNull();
    expect(intent.processRunId).not.toBeNull();
    const timeline = listImplementationTimeline(store, ticketId)!;
    expect(timeline.run.id).toBe(intent.implementationRunId);
    expect(timeline.segments).toHaveLength(0);
  });

  it('a second pending launch for the same ticket/purpose supersedes the first', () => {
    record('l1');
    record('l2', { at: '2026-08-01T10:05:00.000Z' });

    const first = getSessionLaunchIntent(store, 'l1')!;
    expect(first.status).toBe('superseded');
    expect(first.resolvedAt).toBe('2026-08-01T10:05:00.000Z');
    expect(getSessionLaunchIntent(store, 'l2')!.status).toBe('pending');
    expect(confirmSessionLaunchIntent(store, 'l1', {
      ticketId, provider: 'claude', providerSessionId: 'sess-1',
      at: '2026-08-01T10:10:00.000Z',
    })).toBe('not-pending');
  });

  it('supersedePendingLaunchIntents retires every pending intent but the named one', () => {
    record('l1');
    record('l2'); // l1 is already superseded by this record
    // The direct call (record's own helper) retires the only remaining pending.
    const count = supersedePendingLaunchIntents(
      store, ticketId, 'implementation', 'keeper-id', '2026-08-01T10:20:00.000Z',
    );
    expect(count).toBe(1);
    expect(confirmSessionLaunchIntent(store, 'l2', {
      ticketId, provider: 'claude', providerSessionId: 'sess-2',
      at: '2026-08-01T10:21:00.000Z',
    })).toBe('not-pending');
  });

  it('terminal creation failure marks the intent failed and creates no segment', () => {
    record('l1');
    expect(failSessionLaunchIntent(store, 'l1', '2026-08-01T10:02:00.000Z')).toBe(true);
    expect(confirmSessionLaunchIntent(store, 'l1', {
      ticketId, provider: 'claude', providerSessionId: 'sess-1',
      at: '2026-08-01T10:03:00.000Z',
    })).toBe('not-pending');
    const timeline = listImplementationTimeline(store, ticketId)!;
    expect(timeline.segments).toHaveLength(0);
    // A retry reuses the same stable run.
    const retry = record('l2', { at: '2026-08-01T10:04:00.000Z' });
    expect(retry.implementationRunId).toBe(timeline.run.id);
  });

  it('a stale or mismatched start mutates neither the intent nor the timeline', () => {
    const intent = record('l1');
    const timelineBefore = listImplementationTimeline(store, ticketId);

    // Unknown launch id.
    expect(confirmSessionLaunchIntent(store, 'nope', {
      ticketId, provider: 'claude', providerSessionId: 'sess-x',
      at: '2026-08-01T10:05:00.000Z',
    })).toBe('unknown');

    // Mismatched provider — the ticket was switched since the launch was prepared.
    expect(confirmSessionLaunchIntent(store, 'l1', {
      ticketId, provider: 'codex', providerSessionId: 'sess-x',
      at: '2026-08-01T10:06:00.000Z',
    })).toBe('provider-mismatch');

    // Mismatched ticket — the launch id belongs to another board.
    expect(confirmSessionLaunchIntent(store, 'l1', {
      ticketId: ticketId + 999, provider: 'claude', providerSessionId: 'sess-x',
      at: '2026-08-01T10:07:00.000Z',
    })).toBe('ticket-mismatch');

    expect(intent.status).toBe('pending');
    expect(intent.providerSessionId).toBeNull();
    expect(listImplementationTimeline(store, ticketId)).toEqual(timelineBefore);
  });

  it('a fix-purpose launch records no implementation run', () => {
    const intent = record('l-fix', { purpose: 'fix' });
    expect(intent.implementationRunId).toBeNull();
    expect(intent.processRunId).toBeNull();
  });

  it('persists a pending intent across a reopen — only a SessionStart with the same launch id confirms it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-intents-'));
    const path = join(dir, 'karst.db');
    try {
      const first = openStore(path);
      const t = createTicketFlow(first, { key: 'R-1', title: 'r' }).id;
      transition(first, t, 'scope', { kind: 'passed' });
      recordSessionLaunchIntent(first, {
        ticketId: t, launchId: 'persist-1', purpose: 'implementation',
        provider: 'codex', model: 'sol', reason: 'initial', sessionOrigin: 'new',
        at: '2026-08-01T10:00:00.000Z',
      });
      first.close();

      // A reload restores the pending intent from the store, never from memory.
      const reopened = openStore(path);
      expect(confirmSessionLaunchIntent(reopened, 'other-id', {
        ticketId: t, provider: 'codex', providerSessionId: 'sess-x',
        at: '2026-08-01T10:05:00.000Z',
      })).toBe('unknown');
      // The stable run was opened with the intent, but no segment exists until
      // the matching SessionStart confirms it.
      expect(listImplementationTimeline(reopened, t)!.segments).toHaveLength(0);

      expect(confirmSessionLaunchIntent(reopened, 'persist-1', {
        ticketId: t, provider: 'codex', providerSessionId: 'codex-session-2',
        at: '2026-08-01T10:06:00.000Z',
      })).toBe('confirmed');
      const timeline = listImplementationTimeline(reopened, t)!;
      expect(timeline.segments.map((s) => [s.provider, s.model])).toEqual([
        ['codex', 'sol'],
      ]);
      expect(timeline.segments[0]!.providerSessionId).toBe('codex-session-2');
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
