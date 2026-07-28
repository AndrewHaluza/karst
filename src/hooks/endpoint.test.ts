import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import {
  parseHookRequestTarget,
  startHookEndpoint,
  type HookEndpoint,
} from './endpoint.js';
import { connect, type Socket } from 'node:net';

async function post(url: string, body: unknown): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

async function rawRequest(port: number, target: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(
        `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}`,
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
      if (!match) reject(new Error(`missing HTTP status in ${response}`));
      else resolve(Number(match[1]));
    });
    socket.on('error', reject);
  });
}

describe('startHookEndpoint', () => {
  let store: Store;
  let ep: HookEndpoint;
  const WT = '/repo/.karst/worktrees/x';

  beforeEach(async () => {
    store = openStore(':memory:');
    ep = await startHookEndpoint(store, 0);
  });
  afterEach(async () => {
    await ep?.close();
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

  // The reported bug: a session bakes the port into its --settings at launch and
  // never re-reads it. An ephemeral port meant every host restart moved the
  // endpoint, and every hook from an already-running session hit a dead port
  // ("connect ECONNREFUSED 127.0.0.1:53992"). Rebinding the remembered port is
  // what makes those sessions work again after a reload.
  it('rebinds the requested port so a restarted host keeps a live session’s hooks working', async () => {
    const wanted = ep.port;
    await ep.close();

    ep = await startHookEndpoint(store, wanted);

    expect(ep.port).toBe(wanted);
  });

  // Another window already holds the remembered port. Failing to listen would
  // take the whole hook channel down for this host; an ephemeral port at least
  // serves sessions launched from here.
  it('falls back to an ephemeral port when the requested one is taken', async () => {
    const other = await startHookEndpoint(store, 0);
    try {
      const fallback = await startHookEndpoint(store, other.port);
      expect(fallback.port).toBeGreaterThan(0);
      expect(fallback.port).not.toBe(other.port);
      await fallback.close();
    } finally {
      await other.close();
    }
  });

  it('a SessionStart POST flips the ticket agent_state and returns 2xx', async () => {
    const id = ticketAt();
    const status = await post(ep.url, { hook_event_name: 'SessionStart', cwd: WT });
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('derives the launch generation from the endpoint URL, not hook JSON', async () => {
    await ep.close();
    let observedLaunch: string | undefined;
    ep = await startHookEndpoint(store, 0, (_ticketId, payload) => {
      observedLaunch = payload.launchId;
    });
    ticketAt();

    const launchId = '123e4567-e89b-42d3-a456-426614174000';
    await post(`${ep.url}?karstLaunch=${launchId}`, {
      hook_event_name: 'SessionStart',
      cwd: WT,
      launchId: 'forged-body-value',
    });

    expect(observedLaunch).toBe(launchId);
  });

  it('rejects malformed request targets without dispatching', async () => {
    const id = ticketAt();
    expect(parseHookRequestTarget('http://[')).toEqual({
      kind: 'bad-request',
    });
    expect(await rawRequest(ep.port, '/hooks?karstLaunch=%')).toBe(400);
    expect(getTicket(store, id).agentState).toBe('none');
  });

  it('returns 404 for POSTs outside the hook path', async () => {
    const id = ticketAt();
    expect(
      await post(`${ep.url.replace('/hooks', '/not-hooks')}`, {
        hook_event_name: 'SessionStart',
        cwd: WT,
      }),
    ).toBe(404);
    expect(getTicket(store, id).agentState).toBe('none');
  });

  it('rejects a malformed launch generation without dispatching', async () => {
    const id = ticketAt();
    expect(
      await post(`${ep.url}?karstLaunch=not-a-uuid`, {
        hook_event_name: 'SessionStart',
        cwd: WT,
      }),
    ).toBe(400);
    expect(getTicket(store, id).agentState).toBe('none');
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

  it('disconnects an incomplete request at its deadline without blocking the next hook', async () => {
    await ep.close();
    ep = await startHookEndpoint(
      store,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      { requestTimeoutMs: 40 },
    );
    const id = ticketAt();
    let partial: Socket | undefined;
    await new Promise<void>((resolve, reject) => {
      partial = connect(ep.port, '127.0.0.1');
      partial.on('connect', () => {
        partial!.write(
          'POST /hooks HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{',
        );
        resolve();
      });
      partial.on('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('partial hook socket was not disconnected')),
        1_000,
      );
      partial!.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(getTicket(store, id).agentState).toBe('none');

    expect(await post(ep.url, { hook_event_name: 'SessionStart', cwd: WT })).toBe(204);
    expect(getTicket(store, id).agentState).toBe('running');
  });

  it('close is awaitable, idempotent, and settles after the port stops accepting connections', async () => {
    const port = ep.port;
    const firstClose = ep.close();
    const secondClose = ep.close();
    await Promise.all([firstClose, secondClose]);

    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1');
        socket.on('connect', () => reject(new Error('endpoint still accepted a connection')));
        socket.on('error', () => resolve());
      }),
    ).resolves.toBeUndefined();
  });
});
