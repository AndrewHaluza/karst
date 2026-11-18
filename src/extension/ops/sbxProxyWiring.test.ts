import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRow } from '../../agent/accounts/accountOps.js';
import type { SecretStore } from '../secretStore.js';
import { createSbxProxyWiring, intervalEvery, PROXY_PROBE_MS } from './sbxProxyWiring.js';

const rows: AccountRow[] = [{ name: 'default', active: true }, { name: 'work', active: false, account: { kind: 'subscription', source: 'managed', dir: '/m' } }];

function setup(over: { stored?: boolean; sync?: () => Promise<void>; probe?: () => Promise<boolean>; list?: () => Promise<AccountRow[]> } = {}) {
  const map = new Map<string, string>(over.stored ? [['karst.sbx.token.claude.work', 'sk-ant-oat01-abcdefghijkl']] : []);
  const secrets: SecretStore = { get: async (k) => map.get(k), store: async () => {}, delete: async () => {} };
  const calls = { sync: 0, probe: 0, listCore: [] as string[], every: [] as number[], cancelled: 0 };
  const debug: string[] = [];
  let tick: () => void = () => { throw new Error('no timer'); };
  const wiring = createSbxProxyWiring({
    lifecycle: { sync: async () => { calls.sync += 1; await over.sync?.(); }, probe: async () => { calls.probe += 1; return over.probe ? over.probe() : false; } },
    listAccounts: async (core) => { calls.listCore.push(core); return over.list ? over.list() : rows; },
    secrets,
    every: (fn, ms) => { tick = fn; calls.every.push(ms); return () => { calls.cancelled += 1; }; },
    debug: (m) => debug.push(m),
  });
  return { wiring, calls, debug, tick: () => tick() };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('sbx proxy wiring', () => {
  it('does not sync at activation when no account has a token', async () => {
    const s = setup();
    expect(await s.wiring.startIfTokens()).toBe(false);
    expect(s.calls.sync).toBe(0);
    expect(s.calls.listCore).toEqual(['claude']);
  });

  it('syncs once at activation when an account has a token', async () => {
    const s = setup({ stored: true });
    expect(await s.wiring.startIfTokens()).toBe(true);
    expect(s.calls.sync).toBe(1);
  });

  it('probes every 30 s, but only after a sync started the proxy', async () => {
    const s = setup();
    expect(s.calls.every).toEqual([PROXY_PROBE_MS]);
    expect(PROXY_PROBE_MS).toBe(30_000);
    s.tick(); await settle();
    expect(s.calls.probe).toBe(0);
    await s.wiring.sync();
    s.tick(); await settle();
    expect(s.calls.probe).toBe(1);
  });

  it('logs a failed sync, probe and activation without throwing', async () => {
    const s = setup({ sync: async () => { throw new Error('boom'); }, probe: async () => { throw new Error('gone'); } });
    await s.wiring.sync();
    s.tick(); await settle();
    expect(s.debug).toEqual(['[oauth-proxy] sync failed: boom', '[oauth-proxy] probe failed: gone']);
    const a = setup({ list: async () => { throw new Error('nolist'); } });
    expect(await a.wiring.startIfTokens()).toBe(false);
    expect(a.debug).toEqual(['[oauth-proxy] activation failed: nolist']);
    const b = setup({ sync: async () => { throw 'x'; } });
    await b.wiring.sync();
    expect(b.debug).toEqual(['[oauth-proxy] sync failed: error']);
  });

  it('cancels the timer on dispose', () => {
    const s = setup();
    s.wiring.dispose();
    expect(s.calls.cancelled).toBe(1);
  });
});

describe('intervalEvery', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('runs on the interval, never holds the process open, and stops on cancel', () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const real = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => { const t = real(fn, ms); const u = t.unref.bind(t); t.unref = (() => { unref(); return u(); }) as typeof t.unref; return t; }) as typeof setInterval);
    let runs = 0;
    const cancel = intervalEvery(() => { runs += 1; }, 1000);
    expect(unref).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2500);
    expect(runs).toBe(2);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(runs).toBe(2);
    spy.mockRestore();
  });
});
