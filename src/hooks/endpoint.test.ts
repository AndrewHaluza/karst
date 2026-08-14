import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket, getTicketByKey } from '../store/tickets.js';
import {
  parseHookRequestTarget,
  startHookEndpoint,
  type HookEndpoint,
} from './endpoint.js';
import { connect, type Socket } from 'node:net';
import { createHookChannelRecorder } from '../diagnostics/hookChannel.js';
import { recordSessionLaunchIntent } from '../store/sessionLaunchIntents.js';
import { listTokenUsage } from '../store/tokenUsage.js';

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

    // Between close and rebind the OS can hand the just-freed port to a
    // CONCURRENT test's ephemeral `listen(0)` (ephemeral ports reuse freed
    // ones), so the endpoint — which falls back on EADDRINUSE by design —
    // lands on a different port. That is correct behavior, not a rebind
    // failure, so retry until the remembered port is actually reclaimable.
    let rebound = false;
    for (let attempt = 0; attempt < 20 && !rebound; attempt++) {
      const candidate = await startHookEndpoint(store, wanted);
      if (candidate.port === wanted) {
        ep = candidate;
        rebound = true;
      } else {
        await candidate.close();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    expect(rebound).toBe(true);
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

  it('a UsageUpdate POST rides the same authenticated path and records a measured delta', async () => {
    await ep.close();
    // The launch-intent handshake needs a provider resolver, or the SessionStart
    // below cannot confirm the prepared launch.
    ep = await startHookEndpoint(store, 0, undefined, undefined, undefined, () => 'claude');
    const id = ticketAt();
    // Prepare + confirm a launch so the session has a durable binding. The
    // SessionStart must itself carry the launch generation in the URL.
    recordSessionLaunchIntent(store, {
      ticketId: id, launchId: '123e4567-e89b-42d3-a456-426614174000',
      purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'initial', sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
    });
    await post(`${ep.url}?karstLaunch=123e4567-e89b-42d3-a456-426614174000`, {
      hook_event_name: 'SessionStart',
      cwd: WT,
      session_id: 'sess-1',
    });

    const status = await post(ep.url, {
      hook_event_name: 'UsageUpdate',
      cwd: WT,
      session_id: 'sess-1',
      usage: { event_id: 'e1', input: 1_000, output: 200 },
    });
    expect(status).toBe(204);
    const entries = listTokenUsage(store, { ticketId: id });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ callSite: 'implementation', inputTokens: 1_000 });
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

  it('an oversized body is accepted (204), ignored, and counted as too-large', async () => {
    const recorder = createHookChannelRecorder();
    await ep.close();
    ep = await startHookEndpoint(store, 0, undefined, undefined, undefined, undefined, {
      recorder,
    });
    const id = ticketAt();
    const huge = 'x'.repeat(1024 * 1024 + 4096);
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'SessionStart', cwd: WT, pad: huge }),
    });
    await res.text().catch(() => '');
    expect(res.status).toBe(204);
    expect(getTicket(store, id).agentState).toBe('none');
    expect(recorder.snapshot().outcomes['too-large']).toBe(1);
  });

  it('disconnects an oversized body that never finishes at the request deadline', async () => {
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
          'POST /hooks HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 999999999\r\n\r\n' +
            'x'.repeat(1024 * 1024 + 4096),
        );
        resolve();
      });
      partial.on('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('oversized hook socket was not disconnected')),
        1_000,
      );
      // Drain the 204 the server already sent — a real hook sender (curl,
      // Claude's HTTP client) reads its response, and only then observes the
      // disconnect at the deadline.
      partial!.resume();
      partial!.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
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

  it('records every request outcome so a failed agent-side hook has a host-side reason', async () => {
    // The agent only ever renders `hook exited with code 1`; the status this
    // endpoint returned is the half of the story the report has to carry.
    const recorder = createHookChannelRecorder();
    const observed = await startHookEndpoint(
      store,
      0,
      undefined,
      () => {},
      undefined,
      undefined,
      { recorder },
    );
    try {
      const id = ticketAt();
      expect(await post(observed.url, { hook_event_name: 'Stop', cwd: WT })).toBe(204);
      expect(await post(observed.url, { hook_event_name: 'Stop', cwd: '/elsewhere' })).toBe(204);
      expect(await post(observed.url, 'not-an-object')).toBe(204);
      expect(await rawRequest(observed.port, '/nope')).toBe(404);
      expect(await rawRequest(observed.port, '/hooks?karstLaunch=bogus')).toBe(400);
      expect(getTicket(store, id).agentState).toBe('idle');

      const snapshot = recorder.snapshot();
      expect(snapshot.outcomes).toEqual({
        accepted: 2,
        applied: 1,
        'unknown-worktree': 1,
        'malformed-body': 1,
        'not-found': 1,
        'bad-request': 1,
      });
      expect(snapshot.events.Stop).toBe(4)
      expect(snapshot.firstAt).not.toBeNull();
    } finally {
      await observed.close();
    }
  });

  it('keeps serving hooks when the recorder throws', async () => {
    const broken = await startHookEndpoint(store, 0, undefined, () => {}, undefined, undefined, {
      recorder: {
        record: () => {
          throw new Error('recorder defect');
        },
        snapshot: () => {
          throw new Error('recorder defect');
        },
      },
    });
    try {
      const id = ticketAt();
      expect(await post(broken.url, { hook_event_name: 'SessionStart', cwd: WT })).toBe(204);
      expect(getTicket(store, id).agentState).toBe('running');
    } finally {
      await broken.close();
    }
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

describe('POST /tickets', () => {
  let store: Store;
  let ep: HookEndpoint;
  let created: number[];

  beforeEach(async () => {
    store = openStore(':memory:');
    created = [];
    ep = await startHookEndpoint(store, 0, undefined, undefined, undefined, undefined, {
      ticketApi: {
        projectId: () => 7,
        onTicketCreated: (id) => created.push(id),
      },
    });
  });
  afterEach(async () => {
    await ep?.close();
    store.close();
  });

  const ticketsUrl = (): string => `${ep.url.replace(/\/hooks$/, '')}/tickets`;

  const postJson = async (body: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(ticketsUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  it('creates a ticket with a title and description and returns it', async () => {
    const { status, json } = await postJson({
      title: 'Fix login',
      description: 'session cookie not set',
    });
    expect(status).toBe(201);
    expect(json).toMatchObject({
      ok: true,
      ticket: { title: 'Fix login', description: 'session cookie not set' },
    });
    const key = (json as { ticket: { key: string } }).ticket.key;
    expect(key).toBe('FIX-LOGIN');
    expect(getTicketByKey(store, key)).not.toBeNull();
    expect(created).toEqual([expect.any(Number)]);
  });

  it('derives the key from the title when none is given', async () => {
    const { json } = await postJson({ title: 'Fix login' });
    expect((json as { ticket: { key: string } }).ticket.key).toBe('FIX-LOGIN');
  });

  it('honors an explicit key', async () => {
    const { json } = await postJson({ title: 'Fix login', key: 'LOGIN-1' });
    expect((json as { ticket: { key: string } }).ticket.key).toBe('LOGIN-1');
  });

  it('rejects a missing title with 400 and a JSON error', async () => {
    const { status, json } = await postJson({ description: 'no title' });
    expect(status).toBe(400);
    expect(json).toEqual({ ok: false, error: 'title is required' });
  });

  it('rejects a non-string title with 400', async () => {
    const { status, json } = await postJson({ title: 42 });
    expect(status).toBe(400);
    expect(json).toEqual({ ok: false, error: 'title must be a string' });
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await fetch(ticketsUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'request body is not valid JSON',
    });
  });

  it('rejects a non-object JSON body with 400', async () => {
    const { status, json } = await postJson(null);
    expect(status).toBe(400);
    expect(json).toEqual({ ok: false, error: 'request body must be a JSON object' });
  });

  it('rejects a GET on /tickets with 404 (the endpoint serves POSTs only)', async () => {
    const res = await fetch(ticketsUrl());
    expect(res.status).toBe(404);
  });

  it('scopes the created ticket to the window project getter', async () => {
    const { json } = await postJson({ title: 'Fix login' });
    const id = (json as { ticket: { id: number } }).ticket.id;
    expect(getTicket(store, id).projectId).toBe(7);
  });

  it('counts nothing on the hook channel recorder for a /tickets request', async () => {
    const recorder = createHookChannelRecorder();
    const ep2 = await startHookEndpoint(store, 0, undefined, undefined, undefined, undefined, {
      recorder,
      ticketApi: { projectId: () => undefined },
    });
    try {
      const res = await fetch(`${ep2.url.replace(/\/hooks$/, '')}/tickets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Fix login' }),
      });
      expect(res.status).toBe(201);
      expect(recorder.snapshot().total).toBe(0);
    } finally {
      await ep2.close();
    }
  });
});
