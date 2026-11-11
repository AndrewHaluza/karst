import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { createHookChannelRecorder } from '../diagnostics/hookChannel.js';
import { startHookEndpoint, type HookEndpoint } from './endpoint.js';

const WT = '/repo/.karst/worktrees/guard';
const LAUNCH = '123e4567-e89b-42d3-a456-426614174000';

interface Sent {
  path: string;
  headers: Record<string, string>;
  body?: string;
}

function send(port: number, { path, headers, body = '{}' }: Sent): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        setHost: false,
        headers: { 'content-length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('hook endpoint: browser and identity guard', () => {
  let store: Store;
  let ep: HookEndpoint;
  const recorder = createHookChannelRecorder();
  let ticketId: number;

  beforeEach(async () => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'G', title: 'g' }).id;
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, 'app', ?, 'karst/g', 'main', 'inherited')`,
      )
      .run(ticketId, WT);
    ep = await startHookEndpoint(store, 0, undefined, () => {}, undefined, undefined, {
      recorder,
      ticketApi: { projectId: () => 1 },
    });
  });
  afterEach(async () => {
    await ep.close();
    store.close();
  });

  const body = JSON.stringify({ hook_event_name: 'SessionStart', cwd: WT });
  const host = (): string => `127.0.0.1:${ep.port}`;
  const json = { 'content-type': 'application/json' };

  it('admits a request with a launch id and a loopback Host', async () => {
    const status = await send(ep.port, {
      path: `/hooks?karstLaunch=${LAUNCH}`,
      headers: { ...json, host: host() },
      body,
    });
    expect(status).toBe(204);
    expect(getTicket(store, ticketId).agentState).toBe('running');
  });

  it('admits the localhost Host name', async () => {
    const status = await send(ep.port, {
      path: `/hooks?karstLaunch=${LAUNCH}`,
      headers: { ...json, host: `localhost:${ep.port}` },
      body,
    });
    expect(status).toBe(204);
  });

  it('refuses a cross-site text/plain POST that carries an Origin header', async () => {
    const status = await send(ep.port, {
      path: `/hooks?karstLaunch=${LAUNCH}`,
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example', host: host() },
      body,
    });
    expect(status).toBe(403);
    expect(getTicket(store, ticketId).agentState).toBe('none');
  });

  it('refuses a Host header that is not loopback with the bound port', async () => {
    for (const bad of ['evil.example', `evil.example:${ep.port}`, '127.0.0.1', `127.0.0.1:${ep.port + 1}`]) {
      const status = await send(ep.port, {
        path: `/hooks?karstLaunch=${LAUNCH}`,
        headers: { ...json, host: bad },
        body,
      });
      expect(status).toBe(403);
    }
    expect(getTicket(store, ticketId).agentState).toBe('none');
  });

  it('refuses a request with no karstLaunch and counts it as bad-request', async () => {
    const before = recorder.snapshot().outcomes['bad-request'] ?? 0;
    const status = await send(ep.port, { path: '/hooks', headers: { ...json, host: host() }, body });
    expect(status).toBe(400);
    expect(recorder.snapshot().outcomes['bad-request']).toBe(before + 1);
    expect(getTicket(store, ticketId).agentState).toBe('none');
  });

  it('counts an Origin or Host refusal as bad-request', async () => {
    const before = recorder.snapshot().outcomes['bad-request'] ?? 0;
    await send(ep.port, {
      path: `/hooks?karstLaunch=${LAUNCH}`,
      headers: { ...json, origin: 'https://evil.example', host: host() },
      body,
    });
    await send(ep.port, {
      path: `/hooks?karstLaunch=${LAUNCH}`,
      headers: { ...json, host: 'evil.example' },
      body,
    });
    expect(recorder.snapshot().outcomes['bad-request']).toBe(before + 2);
  });

  it('refuses POST /tickets with a wrong Host and serves it with a loopback Host', async () => {
    const payload = JSON.stringify({ title: 'T' });
    expect(
      await send(ep.port, { path: '/tickets', headers: { ...json, host: 'evil.example' }, body: payload }),
    ).toBe(403);
    expect(
      await send(ep.port, { path: '/tickets', headers: { ...json, host: host() }, body: payload }),
    ).toBe(201);
  });
});
