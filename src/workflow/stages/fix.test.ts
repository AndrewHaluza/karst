import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { runFix } from './fix.js';
import type { AgentAdapter } from '../../agent/adapter.js';

function walkToFix(store: Store, id: number): void {
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
  transition(store, id, 'uat', { kind: 'failed', reason: 'boom' }); // -> fix
}

function fakeAdapter(): { adapter: AgentAdapter; calls: unknown[] } {
  const calls: unknown[] = [];
  const adapter: AgentAdapter = {
    runHeadless: (opts) => {
      calls.push(opts);
      return Promise.resolve({ sessionId: 'sess-123', verdict: { kind: 'passed' }, raw: '{}' });
    },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: true, resume: true },
  };
  return { adapter, calls };
}

describe('runFix', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    // seed a captured session to resume
    store.db.prepare('UPDATE tickets SET session_id = ? WHERE id = ?').run('sess-abc', id);
    walkToFix(store, id);
  });

  it('resumes the captured session_id and re-enters uat', async () => {
    const { adapter, calls } = fakeAdapter();
    const next = await runFix(store, { ticketId: id, cwd: '/wt' }, adapter);
    expect((calls[0] as { resume?: string }).resume).toBe('sess-abc');
    expect(next).toBe('uat');
    expect(getTicket(store, id).stageCurrent).toBe('uat');
  });

  it('throws when there is no captured session to resume', async () => {
    store.db.prepare('UPDATE tickets SET session_id = NULL WHERE id = ?').run(id);
    const { adapter } = fakeAdapter();
    await expect(runFix(store, { ticketId: id, cwd: '/wt' }, adapter)).rejects.toThrow();
  });
});
