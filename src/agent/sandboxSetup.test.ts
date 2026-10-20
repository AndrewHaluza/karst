import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateProcessRunner, ProcessOutcome } from '../workflow/gates/run.js';
import { ensureSandboxSetup, resetSetupLocks, SETUP_BOUND_MS, type SetupDeps } from './sandboxSetup.js';

const HASH = 'a'.repeat(64);
const done = (output = '', exitCode = 0): ProcessOutcome => ({ kind: 'completed', exitCode, output, stdout: output });

function rig(handler: (args: readonly string[], n: number) => ProcessOutcome | Promise<ProcessOutcome>, over: Partial<SetupDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const calls: string[][] = [];
  const runGate: GateProcessRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return handler(args, calls.length);
  };
  const deps: SetupDeps = { runGate, stateFile: join(dir, 'state', '1.setup.json'), logFile: join(dir, 'logs', 'setup.log'), ...over };
  const setups = () => calls.filter((c) => c[2]?.includes('exec sh -c'));
  return { deps, calls, setups, dir };
}
const req = { key: '1', setup: 'npm ci', cwd: '/clone' };
const fingerprinting = (args: readonly string[]) => args[1]?.startsWith('node -e');

describe('ensureSandboxSetup', () => {
  beforeEach(() => resetSetupLocks());

  it('fingerprints inside the sandbox with node (no sha256sum), only present lockfiles, setup text last', async () => {
    const r = rig((a) => done(fingerprinting(a) ? HASH : ''));
    await ensureSandboxSetup(r.deps, req);
    const fp = r.calls[0]!;
    expect(fp.slice(0, 3)).toEqual(['sh', '-c', 'node -e "$0" "$1"']);
    expect(fp[3]).toContain('existsSync');
    expect(fp[3]).not.toContain('sha256sum');
    expect(fp[3]!.indexOf('package-lock.json')).toBeLessThan(fp[3]!.indexOf('pnpm-lock.yaml'));
    expect(fp[3]!.indexOf('pnpm-lock.yaml')).toBeLessThan(fp[3]!.indexOf('yarn.lock'));
    expect(fp[4]).toBe('npm ci');
  });

  it('runs setup once, records ok, then skips on the same fingerprint', async () => {
    const r = rig((a) => done(fingerprinting(a) ? HASH : ''));
    expect(await ensureSandboxSetup(r.deps, req)).toEqual({ ok: true });
    expect(r.setups()).toHaveLength(1);
    expect(JSON.parse(readFileSync(r.deps.stateFile, 'utf8'))).toMatchObject({ fingerprint: HASH, status: 'ok', exitCode: 0 });
    expect(await ensureSandboxSetup(r.deps, req)).toEqual({ ok: true });
    expect(r.setups()).toHaveLength(1);
  });

  it('reruns when the fingerprint changes', async () => {
    let hash = HASH;
    const r = rig((a) => done(fingerprinting(a) ? hash : ''));
    await ensureSandboxSetup(r.deps, req);
    hash = 'b'.repeat(64);
    await ensureSandboxSetup(r.deps, req);
    expect(r.setups()).toHaveLength(2);
  });

  it('refuses a failed setup with a reason, logs it, and does not retry on the same fingerprint', async () => {
    const r = rig((a) => (fingerprinting(a) ? done(HASH) : done('npm ERR! network blocked registry.npmjs.org', 1)));
    const first = await ensureSandboxSetup(r.deps, req);
    expect(first).toMatchObject({ ok: false });
    expect((first as { reason: string }).reason).toMatch(/^sandbox dependencies not provisioned: .*exit 1.*registry\.npmjs\.org/);
    expect(readFileSync(r.deps.logFile!, 'utf8')).toContain('registry.npmjs.org');
    const second = await ensureSandboxSetup(r.deps, req);
    expect(second.ok).toBe(false);
    expect(r.setups()).toHaveLength(1);
  });

  it('refuses when the fingerprint cannot be computed', async () => {
    const r = rig(() => done('node: not found', 127));
    expect(await ensureSandboxSetup(r.deps, req)).toMatchObject({ ok: false });
    expect(r.setups()).toHaveLength(0);
  });

  it('a caller during a running setup waits on the lock; no second setup starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const r = rig(async (a) => {
      if (fingerprinting(a)) return done(HASH);
      await gate;
      return done();
    });
    const first = ensureSandboxSetup(r.deps, req);
    await vi.waitFor(() => expect(r.setups()).toHaveLength(1));
    const second = ensureSandboxSetup(r.deps, req);
    release();
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(r.setups()).toHaveLength(1);
  });

  it('a lock held past the bound refuses with the timeout reason', async () => {
    vi.useFakeTimers();
    try {
      const r = rig(async (a) => (fingerprinting(a) ? done(HASH) : new Promise<ProcessOutcome>(() => undefined)));
      void ensureSandboxSetup(r.deps, req);
      await vi.waitFor(() => expect(r.setups()).toHaveLength(1));
      const waiter = ensureSandboxSetup(r.deps, req);
      await vi.advanceTimersByTimeAsync(SETUP_BOUND_MS + 1);
      expect(await waiter).toEqual({ ok: false, reason: 'sandbox setup timed out after 15 min' });
      expect(r.setups()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('state left running with NO lock (previous host / crash)', () => {
    const stale = (at: number) => ({ fingerprint: HASH, status: 'running', exitCode: null, at });
    const seed = async (r: ReturnType<typeof rig>, at: number) => {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(r.dir, 'state'), { recursive: true });
      writeFileSync(r.deps.stateFile, JSON.stringify(stale(at)));
    };

    it('stale: kills via the pid file, reruns once', async () => {
      const r = rig((a) => done(fingerprinting(a) ? HASH : ''), { now: () => 10 * SETUP_BOUND_MS, sleep: () => Promise.resolve() });
      await seed(r, 0);
      expect(await ensureSandboxSetup(r.deps, req)).toEqual({ ok: true });
      expect(r.calls.some((c) => c[2]?.includes('kill $(cat'))).toBe(true);
      expect(r.setups()).toHaveLength(1);
    });

    it('stale with no pid file and a live npm: keeps the process, refuses as timed out, no rerun', async () => {
      const r = rig((a) => {
        if (fingerprinting(a)) return done(HASH);
        if (a[1]?.startsWith('test -f')) return done('', 1);
        return done('', 0); // pgrep hit
      }, { now: () => 10 * SETUP_BOUND_MS, sleep: () => Promise.resolve() });
      await seed(r, 0);
      expect(await ensureSandboxSetup(r.deps, req)).toEqual({ ok: false, reason: 'sandbox setup timed out after 15 min' });
      expect(r.setups()).toHaveLength(0);
    });

    it('young running state: waits (polls) until another run lands ok', async () => {
      let polls = 0;
      const r = rig((a) => done(fingerprinting(a) ? HASH : ''), {
        now: () => 1000,
        sleep: async () => {
          polls += 1;
          const { writeFileSync } = await import('node:fs');
          writeFileSync(r.deps.stateFile, JSON.stringify({ ...stale(1000), status: 'ok', exitCode: 0 }));
        },
      });
      await seed(r, 1000);
      expect(await ensureSandboxSetup(r.deps, req)).toEqual({ ok: true });
      expect(polls).toBe(1);
      expect(r.setups()).toHaveLength(0);
      expect(existsSync(r.deps.stateFile)).toBe(true);
    });
  });
});
