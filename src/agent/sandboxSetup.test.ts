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
const fingerprinting = (args: readonly string[]) => args[1]?.includes('command -v node');

describe('ensureSandboxSetup', () => {
  beforeEach(() => resetSetupLocks());

  it('fingerprints inside the sandbox with node (no sha256sum), only present lockfiles, setup text last', async () => {
    const r = rig((a) => done(fingerprinting(a) ? HASH : ''));
    await ensureSandboxSetup(r.deps, req);
    const fp = r.calls[0]!;
    expect(fp.slice(0, 2)).toEqual(['sh', '-c']);
    expect(fp[2]).toContain('exec node -e "$0" "$1"');
    expect(fp[3]).toContain('existsSync');
    expect(fp[3]).not.toContain('sha256sum');
    expect(fp[3]!.indexOf('package-lock.json')).toBeLessThan(fp[3]!.indexOf('pnpm-lock.yaml'));
    expect(fp[3]!.indexOf('pnpm-lock.yaml')).toBeLessThan(fp[3]!.indexOf('yarn.lock'));
    expect(fp[4]).toBe('npm ci');
  });

  it('fingerprints without node (non-Node repo image) through sha256sum / shasum', async () => {
    const r = rig((a) => done(fingerprinting(a) ? HASH : ''));
    await ensureSandboxSetup(r.deps, req);
    const script = r.calls[0]![2]!;
    expect(script).toContain('command -v node');
    expect(script).toMatch(/sha256sum.*\|\| shasum -a 256/);
    expect(script).toContain('package-lock.json pnpm-lock.yaml yarn.lock');
  });

  it('a stopped setup kills the sandbox-side process and leaves no record, so the next drive reruns', async () => {
    let first = true;
    const r = rig((a) => {
      if (fingerprinting(a)) return done(HASH);
      if (a[1]?.includes('exec sh -c') && first) { first = false; return { kind: 'aborted', output: '' } as ProcessOutcome; }
      return done();
    });
    const stopped = await ensureSandboxSetup(r.deps, req);
    expect(stopped).toMatchObject({ ok: false });
    expect(r.calls.some((c) => c[2]?.includes('pkill -P "$p"'))).toBe(true);
    expect(existsSync(r.deps.stateFile)).toBe(false);
    expect(await ensureSandboxSetup(r.deps, req)).toEqual({ ok: true });
    expect(r.setups()).toHaveLength(2);
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
      expect(r.calls.some((c) => c[2]?.includes('pkill -P "$p"') && c[2]?.includes('kill "$p"'))).toBe(true);
      expect(r.setups()).toHaveLength(1);
    });

    it('stale with no pid file: nothing of ours to kill, no pkill by name, reruns', async () => {
      const r = rig((a) => done(fingerprinting(a) ? HASH : ''), { now: () => 10 * SETUP_BOUND_MS, sleep: () => Promise.resolve() });
      await seed(r, 0);
      expect(await ensureSandboxSetup(r.deps, req)).toEqual({ ok: true });
      expect(r.calls.some((c) => c[2]?.includes('pkill -f'))).toBe(false);
      expect(r.setups()).toHaveLength(1);
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

  describe('failure classes and the single kill retry', () => {
    const setupRig = (exits: number[], output: string, over: Partial<SetupDeps> = {}) => {
      let n = 0;
      return rig((a) => (fingerprinting(a) ? done(HASH) : a[1]?.includes('exec sh -c') ? done(output, exits[Math.min(n++, exits.length - 1)]!) : done()), { sleep: async () => undefined, ...over });
    };

    it('exit 137 reads as a likely OOM kill with the context, and setup.log leads with it', async () => {
      const r = setupRig([137, 137], 'npm warn deprecated prebuild-install@7.1.3', { killContext: async () => 'Docker VM 4.8 GB, 2 other containers running' });
      const res = await ensureSandboxSetup(r.deps, req);
      expect(res).toMatchObject({ ok: false });
      const reason = (res as { reason: string }).reason;
      expect(reason).toContain('killed (exit 137) — likely out of memory (Docker VM 4.8 GB, 2 other containers running)');
      expect(reason).not.toContain('deprecated');
      expect(readFileSync(r.deps.logFile!, 'utf8').split('\n')[0]).toContain('likely out of memory');
    });

    it('a failing killContext never fails the reason', async () => {
      const r = setupRig([137, 137], '', { killContext: async () => { throw new Error('no docker'); } });
      expect(await ensureSandboxSetup(r.deps, req)).toMatchObject({ ok: false, reason: expect.stringContaining('likely out of memory') });
    });

    it('prefers the last npm error line over a later warning', async () => {
      const r = setupRig([1], 'npm error code E404\nnpm error 404 not found\nnpm warn deprecated x');
      expect((await ensureSandboxSetup(r.deps, req) as { reason: string }).reason).toMatch(/: npm error 404 not found$/);
    });

    it('exit 143 reads as terminated', async () => {
      const r = setupRig([143], '');
      expect((await ensureSandboxSetup(r.deps, req) as { reason: string }).reason).toContain('terminated');
    });

    it('a first kill retries once after the delay and succeeds without recording failed', async () => {
      const sleep = vi.fn(async () => undefined);
      const r = setupRig([137, 0], '', { sleep });
      expect(await ensureSandboxSetup(r.deps, req)).toEqual({ ok: true });
      expect(r.setups()).toHaveLength(2);
      expect(sleep).toHaveBeenCalledWith(60_000);
      expect(JSON.parse(readFileSync(r.deps.stateFile, 'utf8')).status).toBe('ok');
    });

    it('two kills record failed', async () => {
      const r = setupRig([137, 137], '');
      await ensureSandboxSetup(r.deps, req);
      expect(r.setups()).toHaveLength(2);
      expect(JSON.parse(readFileSync(r.deps.stateFile, 'utf8')).status).toBe('failed');
    });

    it('a non-137 failure does not retry', async () => {
      const r = setupRig([1], 'boom');
      await ensureSandboxSetup(r.deps, req);
      expect(r.setups()).toHaveLength(1);
    });

    it('Stop during the retry delay aborts with "setup was stopped"', async () => {
      const ac = new AbortController();
      const r = setupRig([137, 0], '', { sleep: () => new Promise<void>(() => undefined) });
      const p = ensureSandboxSetup(r.deps, { ...req, signal: ac.signal });
      await vi.waitFor(() => expect(r.setups()).toHaveLength(1));
      await new Promise((res) => setTimeout(res, 10));
      ac.abort();
      expect(await p).toMatchObject({ ok: false, reason: expect.stringContaining('setup was stopped') });
      expect(r.setups()).toHaveLength(1);
      expect(existsSync(r.deps.stateFile)).toBe(false);
    });
  });
});
