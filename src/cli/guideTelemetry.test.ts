import { describe, it, expect } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { readGuideAttribution, recordGuidePull } from './guideTelemetry.js';

describe('guide-pull attribution', () => {
  it('reads attribution from the launch env', () => {
    const a = readGuideAttribution({
      KARST_DB: '/x/karst.db',
      KARST_TICKET_ID: '42',
      KARST_PROVIDER: 'claude',
      KARST_LAUNCH_ID: 'L1',
    });
    expect(a).toEqual({
      dbPath: '/x/karst.db',
      ticketId: 42,
      launchId: 'L1',
      provider: 'claude',
    });
  });

  it('nulls the db path when the registry env is absent (pure guide read)', () => {
    expect(readGuideAttribution({ KARST_TICKET_ID: '42' }).dbPath).toBeNull();
  });

  it('rejects a non-numeric ticket id rather than inventing one', () => {
    expect(readGuideAttribution({ KARST_TICKET_ID: 'abc' }).ticketId).toBeNull();
  });

  it('records an attributed guide-pull process run, closed as passed', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    const id = recordGuidePull(
      store,
      { dbPath: 'irrelevant', ticketId, launchId: 'L', provider: 'codex' },
      () => '2026-09-07T00:00:00.000Z',
    );
    expect(id).not.toBeNull();
    const row = store.db
      .prepare('SELECT provider, process_id, status, result_kind, prompt_telemetry FROM process_runs WHERE id = ?')
      .get(id) as {
      provider: string;
      process_id: string;
      status: string;
      result_kind: string;
      prompt_telemetry: string;
    };
    expect(row.process_id).toBe('guide-pull');
    expect(row.provider).toBe('codex');
    expect(row.status).toBe('passed');
    expect(row.result_kind).toBe('pull');
    expect(JSON.parse(row.prompt_telemetry)).toMatchObject({ guidePull: true, launchId: 'L' });
    store.close();
  });

  it('records nothing when there is no ticket to attribute to', () => {
    const store = openStore(':memory:');
    const id = recordGuidePull(
      store,
      { dbPath: 'x', ticketId: null, launchId: null, provider: 'claude' },
      () => '2026-09-07T00:00:00.000Z',
    );
    expect(id).toBeNull();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM process_runs').get()).toEqual({ n: 0 });
    store.close();
  });
});
