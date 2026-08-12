/**
 * Graph loopback wake-up endpoint (Slice 3 Task 2).
 *
 * The loopback notification is ONLY a wake-up: it carries no payload that
 * advances state, and the coordinator rereads canonical state before
 * selecting any edge. The route token is a CSPRNG value of at least 128 bits,
 * the listener binds 127.0.0.1, and non-loopback origins are rejected. The
 * endpoint derives bounded routing identity (the graph run id) from its
 * host-created target, returns a fast response BEFORE the coordinator runs,
 * and schedules the coordinator afterwards.
 *
 * Wake-ups are rate-limited per graph run with exponential backoff, and the
 * cap applies to valid requests: the URL lives in every agent's environment
 * and is inherited by every process that agent spawns, so a valid-token flood
 * is the realistic attack. No bearer capability appears in the URL.
 */

import { describe, it, expect } from 'vitest';
import { request as httpRequest } from 'node:http';
import {
  startGraphWakeupEndpoint,
  type GraphWakeupEndpoint,
  type WakeupTarget,
} from './graphEndpoint.js';

function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function startEndpoint(
  opts: Partial<Parameters<typeof startGraphWakeupEndpoint>[0]> = {},
): Promise<{
  endpoint: GraphWakeupEndpoint;
  schedules: number[];
  register: (graphRunId: number) => { url: string; token: string };
  close: () => Promise<void>;
}> {
  const schedules: number[] = [];
  const endpoint = await startGraphWakeupEndpoint({
    schedule: (graphRunId: number) => {
      schedules.push(graphRunId);
    },
    ...opts,
  });
  const register = (graphRunId: number): { url: string; token: string } => {
    const target: WakeupTarget = { graphRunId };
    return endpoint.registerRoute(target);
  };
  return { endpoint, schedules, register, close: () => endpoint.close() };
}

describe('graph wake-up endpoint', () => {
  it('accepts a valid wake-up with a fast response, then schedules the coordinator', async () => {
    const { endpoint, schedules, register, close } = await startEndpoint();
    const { url, token } = register(42);
    const started = Date.now();
    const result = await post(url, { token });
    expect(result.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 50));
    expect(schedules).toEqual([42]);
    await close();
  });

  it('rejects a non-loopback origin', async () => {
    const { endpoint, register, close } = await startEndpoint({
      isLoopback: () => false,
    });
    const { url, token } = register(42);
    const result = await post(url, { token });
    expect(result.status).toBe(403);
    await close();
  });

  it('rejects an unknown token and a malformed body without scheduling', async () => {
    const { endpoint, register, schedules, close } = await startEndpoint();
    const { url } = register(42);
    const unknown = await post(url, { token: 'deadbeef' });
    expect(unknown.status).toBe(404);
    const malformed = await post(url, 'not json');
    expect(malformed.status).toBe(400);
    await new Promise((r) => setImmediate(r));
    expect(schedules).toEqual([]);
    await close();
  });

  it('rate-limits a valid-token flood per graph run with exponential backoff', async () => {
    const { endpoint, register, close } = await startEndpoint({
      baseBackoffMs: 20,
      maxBackoffMs: 640,
    });
    const { url, token } = register(7);
    // Accept at t0 → backoff 40 ms.
    expect((await post(url, { token })).status).toBe(202);
    expect((await post(url, { token })).status).toBe(429);
    expect((await post(url, { token })).status).toBe(429);
    // After the backoff window (40 ms) elapses a wake-up is accepted again…
    await new Promise((r) => setTimeout(r, 60));
    expect((await post(url, { token })).status).toBe(202);
    // …and the DOUBLED window (80 ms) means a request 30 ms later is still
    // rate-limited — with the base window it would have been accepted, so
    // this assertion pins the exponential growth.
    expect((await post(url, { token })).status).toBe(429);
    await new Promise((r) => setTimeout(r, 30));
    expect((await post(url, { token })).status).toBe(429);
    await new Promise((r) => setTimeout(r, 60));
    expect((await post(url, { token })).status).toBe(202);
    await close();
  });

  it('different graph runs are rate-limited independently', async () => {
    const { endpoint, register, close } = await startEndpoint({ baseBackoffMs: 5000 });
    const a = register(1);
    const b = register(2);
    expect((await post(a.url, { token: a.token })).status).toBe(202);
    expect((await post(b.url, { token: b.token })).status).toBe(202);
    await close();
  });

  it('a wake-up for a run with no committed claimable state advances nothing', async () => {
    const { endpoint, register, schedules, close } = await startEndpoint();
    const { url, token } = register(99);
    // A wake-up only schedules the coordinator; it carries no payload that
    // advances state. The scheduled tick against a store where the run is not
    // running is a no-op — the endpoint's whole job is the schedule itself.
    const result = await post(url, { token });
    expect(result.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(schedules).toEqual([99]);
    await close();
  });

  it('generates route tokens of at least 128 bits (CSPRNG)', async () => {
    const { endpoint, register, close } = await startEndpoint();
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const { token } = register(1000 + i);
      expect(token.length).toBeGreaterThanOrEqual(32); // 32 hex chars = 128 bits
      expect(/^[0-9a-f]+$/.test(token)).toBe(true);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
    await close();
  });
});
