import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { startHookEndpoint, type HookEndpoint } from './endpoint.js';

async function post(url: string, body: unknown): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

describe('startHookEndpoint', () => {
  let store: Store;
  let ep: HookEndpoint;
  const WT = '/repo/.karst/worktrees/x';

  beforeEach(async () => {
    store = openStore(':memory:');
    ep = await startHookEndpoint(store, 0);
  });
  afterEach(() => {
    ep.close();
    store.close();
  });

  function ticketAt(): number {
    const t = createTicket(store, { key: 'A', title: 'a' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`,
      )
      .run(t.id, WT);
    return t.id;
  }

  it('binds a port and exposes its url', () => {
    expect(ep.port).toBeGreaterThan(0);
    expect(ep.url).toContain(String(ep.port));
  });

  it('a SessionStart POST flips the ticket agent_state and returns 2xx', async () => {
    const id = ticketAt();
    const status = await post(ep.url, { hook_event_name: 'SessionStart', cwd: WT });
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('a malformed body returns 2xx and does not crash the endpoint', async () => {
    const res = await fetch(ep.url, { method: 'POST', body: 'not json{' });
    await res.text();
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('a non-POST request is rejected with 404', async () => {
    const res = await fetch(ep.url, { method: 'GET' });
    await res.text();
    expect(res.status).toBe(404);
  });

  it('an oversized body is rejected with 413 and does not mutate', async () => {
    const id = ticketAt();
    const huge = 'x'.repeat(70 * 1024);
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'SessionStart', cwd: WT, pad: huge }),
    });
    await res.text().catch(() => '');
    expect(res.status).toBe(413);
    expect(getTicket(store, id).agentState).toBe('none');
  });

  it('a payload with a non-string cwd is ignored (validated at the boundary)', async () => {
    const id = ticketAt();
    const status = await post(ep.url, { hook_event_name: 'SessionStart', cwd: 123 });
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    expect(getTicket(store, id).agentState).toBe('none');
  });
});
