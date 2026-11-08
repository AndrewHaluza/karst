import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../adapter.js';
import { withHeadlessLedger } from './headlessLedger.js';
import { loadSessionLedger, saveSessionLedger } from './sessionLedgerStore.js';
import {
  accountForLaunch, configureAccounts, configureRecordedAccountLookup, configureSessionLedgerSink,
  liveHeadlessAccounts, recordHeadlessSession, resetAccounts, resetSessionLedger, SESSION_LEDGER_MAX, seedSessionLedger,
  mergeSessionLedger,
} from './registry.js';

afterEach(() => {
  resetAccounts();
  resetSessionLedger();
  configureRecordedAccountLookup(undefined);
});

const cfg = { claude: { active: 'work', list: { work: { kind: 'subscription' as const, source: 'folder' as const, dir: '/w' } } } };
const fake = (sessionId: string, seen: { live?: string[] } = {}): AgentAdapter =>
  ({
    requiredBinary: 'claude',
    runHeadless: async () => { seen.live = liveHeadlessAccounts('claude'); return { sessionId, verdict: null, raw: '' }; },
  }) as unknown as AgentAdapter;

describe('headless session ledger (AC-55)', () => {
  it('records the active account of a headless session and marks the run live while it runs', async () => {
    configureAccounts(cfg);
    const seen: { live?: string[] } = {};
    await withHeadlessLedger('claude', fake('s1', seen)).runHeadless({ prompt: 'p', cwd: '/c' } as never);
    expect(seen.live).toEqual(['work']);
    expect(liveHeadlessAccounts('claude')).toEqual([]);
    configureAccounts({ claude: { active: 'default', list: cfg.claude.list } });
    expect(accountForLaunch('claude', 's1')).toBe('work');
  });

  it('ends the live mark when the run throws, and records nothing', async () => {
    configureAccounts(cfg);
    const bad = { runHeadless: async () => { throw new Error('boom'); } } as unknown as AgentAdapter;
    await expect(withHeadlessLedger('claude', bad).runHeadless({ prompt: 'p', cwd: '/c' } as never)).rejects.toThrow('boom');
    expect(liveHeadlessAccounts('claude')).toEqual([]);
    expect(accountForLaunch('claude', 's1')).toBeUndefined();
  });

  it('a resume keeps the recorded account, and other members pass through', async () => {
    configureAccounts(cfg);
    seedSessionLedger({ 'claude:old': 'default' });
    const seen: { live?: string[] } = {};
    const wrapped = withHeadlessLedger('claude', fake('old', seen));
    await wrapped.runHeadless({ prompt: 'p', cwd: '/c', resume: 'old' } as never);
    expect(seen.live).toEqual(['default']);
    expect(wrapped.requiredBinary).toBe('claude');
  });

  it('the launch intent record wins over the ledger; an empty session id is not recorded', () => {
    seedSessionLedger({ 'claude:x': 'a' });
    configureRecordedAccountLookup(() => 'b');
    expect(accountForLaunch('claude', 'x')).toBe('b');
    recordHeadlessSession('claude', '', 'z');
    configureRecordedAccountLookup(undefined);
    expect(accountForLaunch('claude', '')).toBeUndefined();
  });

  it('sends one entry per change to the sink and keeps a bounded ledger', () => {
    const sunk: Array<[string, string]> = [];
    configureSessionLedgerSink((k, v) => sunk.push([k, v]));
    for (let i = 0; i <= SESSION_LEDGER_MAX; i++) recordHeadlessSession('claude', `s${i}`, 'a');
    expect(sunk[0]).toEqual(['claude:s0', 'a']);
    expect(sunk).toHaveLength(SESSION_LEDGER_MAX + 1);
    expect(accountForLaunch('claude', 's0')).toBeUndefined();
    expect(accountForLaunch('claude', `s${SESSION_LEDGER_MAX}`)).toBe('a');
  });

  it('merges entries of another window without replacing its own, and stays bounded', () => {
    recordHeadlessSession('claude', 'mine', 'a');
    mergeSessionLedger({ 'claude:mine': 'other', 'claude:theirs': 'b' });
    expect(accountForLaunch('claude', 'mine')).toBe('a');
    expect(accountForLaunch('claude', 'theirs')).toBe('b');
    mergeSessionLedger(Object.fromEntries(Array.from({ length: SESSION_LEDGER_MAX }, (_, i) => [`codex:m${i}`, 'c'])));
    expect(accountForLaunch('claude', 'mine')).toBeUndefined();
    expect(accountForLaunch('codex', `m${SESSION_LEDGER_MAX - 1}`)).toBe('c');
  });

  it('counts two runs of one account and ends them one by one', async () => {
    configureAccounts(cfg);
    const seen: { live?: string[] } = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = { runHeadless: async () => { await gate; return { sessionId: 'a', verdict: null, raw: '' }; } } as unknown as AgentAdapter;
    const w = withHeadlessLedger('claude', slow);
    const p1 = w.runHeadless({ prompt: 'p', cwd: '/c' } as never);
    const p2 = w.runHeadless({ prompt: 'p', cwd: '/c' } as never);
    expect(liveHeadlessAccounts('claude')).toEqual(['work']);
    release();
    await Promise.all([p1, p2]);
    expect(liveHeadlessAccounts('claude')).toEqual([]);
    void seen;
  });
});

describe('session ledger file', () => {
  it('round-trips, treats a missing file as empty and drops non-string values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ledger-'));
    try {
      expect(await loadSessionLedger(root)).toEqual({});
      await saveSessionLedger(root, { 'claude:s': 'work' });
      expect(await loadSessionLedger(root)).toEqual({ 'claude:s': 'work' });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(root, 'session-accounts.json'), '{"a":"b","c":1}');
      expect(await loadSessionLedger(root)).toEqual({ a: 'b' });
      await writeFile(join(root, 'session-accounts.json'), '[1]');
      expect(await loadSessionLedger(root)).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
