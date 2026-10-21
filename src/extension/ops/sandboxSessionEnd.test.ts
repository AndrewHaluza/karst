import { describe, expect, it } from 'vitest';
import { createSandboxSessionEnder, SESSION_END_SETTLE_MS } from './sandboxSessionEnd.js';

function setup(over: { launch?: string; bound?: string } = {}) {
  const state = { launch: over.launch ?? 'L1', bound: over.bound ?? 's1' };
  const stops: number[] = [];
  const logs: string[] = [];
  let pending: { fn: () => void; ms: number } | undefined;
  const ender = createSandboxSessionEnder({
    launchIdFor: () => state.launch,
    boundSessionId: () => state.bound,
    stop: async (id) => { stops.push(id); },
    log: (m) => logs.push(m),
    schedule: (fn, ms) => { const p = { fn, ms }; pending = p; return () => { if (pending === p) pending = undefined; }; },
  });
  const idle = (sessionId = 's1', launchId = state.launch) => ender.onHook(7, { hook_event_name: 'session.idle', session_id: sessionId, launchId });
  const fire = () => { const p = pending; pending = undefined; p?.fn(); };
  return { ender, state, stops, logs, idle, fire, armed: () => pending !== undefined, ms: () => pending?.ms };
}

describe('sandbox session ender', () => {
  it('stops once after accepted marker then idle settles', () => {
    const t = setup();
    t.ender.accepted(7);
    t.idle();
    expect(t.ms()).toBe(SESSION_END_SETTLE_MS);
    t.fire();
    expect(t.stops).toEqual([7]);
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toContain('ending the sandbox session');
  });

  it('arms when the idle line beat the marker reply', () => {
    const t = setup();
    t.idle();
    expect(t.armed()).toBe(false);
    t.ender.accepted(7);
    t.fire();
    expect(t.stops).toEqual([7]);
  });

  it('never stops an idle without an accepted marker', () => {
    const t = setup();
    t.idle();
    t.fire();
    expect(t.stops).toEqual([]);
  });

  it('a new turn within the settle delay cancels the stop', () => {
    const t = setup();
    t.ender.accepted(7);
    t.idle();
    t.ender.onHook(7, { hook_event_name: 'session.status', message: 'busy', session_id: 's1' });
    t.fire();
    expect(t.stops).toEqual([]);
  });

  it('a stale session idle does not stop', () => {
    const t = setup();
    t.ender.accepted(7);
    t.idle('old');
    t.fire();
    expect(t.stops).toEqual([]);
  });

  it('a marker accepted in an older launch does not end a relaunched session', () => {
    const t = setup();
    t.ender.accepted(7);
    t.state.launch = 'L2';
    t.idle();
    t.fire();
    expect(t.stops).toEqual([]);
  });

  it('re-checks the launch when the settle delay ends', () => {
    const t = setup();
    t.ender.accepted(7);
    t.idle();
    t.state.launch = 'L2';
    t.fire();
    expect(t.stops).toEqual([]);
  });

  it('does not stop twice for one accepted marker', () => {
    const t = setup();
    t.ender.accepted(7);
    t.idle();
    t.fire();
    t.idle();
    t.fire();
    expect(t.stops).toEqual([7]);
  });

  it('logs a failed stop instead of throwing', async () => {
    const logs: string[] = [];
    let fn: (() => void) | undefined;
    const ender = createSandboxSessionEnder({
      launchIdFor: () => 'L', boundSessionId: () => 's', stop: () => Promise.reject(new Error('boom')),
      log: (m) => logs.push(m), schedule: (f) => { fn = f; return () => undefined; },
    });
    ender.accepted(1);
    ender.onHook(1, { hook_event_name: 'session.idle', session_id: 's', launchId: 'L' });
    fn!();
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });
});
