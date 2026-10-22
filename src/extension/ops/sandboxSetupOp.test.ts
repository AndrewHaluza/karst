import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bridgePaths } from '../../agent/bridge/bridgeDir.js';
import { resetSetupLocks } from '../../agent/sandboxSetup.js';
import { manifest as buildManifest, repo } from '../../manifest/fixtures.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { clearSetupState, provisionTicketSandbox, type TicketSetupDeps } from './sandboxSetupOp.js';

const HASH = 'c'.repeat(64);

function rig(opts: { setup?: string; setupHosts?: string[]; exit?: number; sandboxed?: boolean; docker?: boolean; turn?: boolean } = {}) {
  const errors: string[] = [];
  const ran: string[][] = [];
  const runGate: GateProcessRunner = async (_c, args) => {
    ran.push([...args]);
    const fp = args[1]?.includes('command -v node');
    return { kind: 'completed', exitCode: fp ? 0 : (opts.exit ?? 0), output: fp ? HASH : 'boom', stdout: fp ? HASH : '' };
  };
  const repoKey = 'app';
  const manifest = buildManifest({ [repoKey]: repo(opts.setup ? { sandbox: { setup: opts.setup, ...(opts.setupHosts ? { setupHosts: opts.setupHosts } : {}) } } : {}) });
  const paths = bridgePaths(mkdtempSync(join(tmpdir(), 'op-')), 7);
  const windows: string[] = [];
  const deps: TicketSetupDeps = {
    windowOf: () => ({
      windowNeedsIdle: opts.docker === true,
      setupWindow: async (hosts) => { windows.push(`open ${hosts.join(',')}`); return { ok: true, close: async () => { windows.push('close'); } }; },
    }),
    turnActive: () => opts.turn === true,
    manifest: () => manifest, worktrees: () => [{ repo: repoKey, path: '/wt' }], gateProcess: () => (opts.sandboxed === false ? undefined : runGate),
    bridgeOf: () => paths, ticketLabel: () => 'T7', notify: { info: () => undefined, warn: () => undefined, error: (m) => { errors.push(m); return Promise.resolve(); } },
  };
  return { deps, errors, ran, paths, manifest, windows };
}

describe('provisionTicketSandbox', () => {
  beforeEach(() => resetSetupLocks());

  it('opens the declared setupHosts around the setup, the defaults when none are declared', async () => {
    const custom = rig({ setup: 'npm ci', setupHosts: ['pypi.org'] });
    await provisionTicketSandbox(custom.deps, 7);
    expect(custom.windows).toEqual(['open pypi.org', 'close']);
    resetSetupLocks();
    const plain = rig({ setup: 'npm ci' });
    await provisionTicketSandbox(plain.deps, 7);
    expect(plain.windows).toEqual(['open registry.npmjs.org,github.com,objects.githubusercontent.com', 'close']);
  });

  it('docker: the create-time background start is skipped (the window needs an idle agent); sbx starts it', async () => {
    const docker = rig({ setup: 'npm ci', docker: true });
    expect(await provisionTicketSandbox(docker.deps, 7, { background: true })).toEqual({ ok: true });
    expect(docker.ran).toHaveLength(0);
    const sbx = rig({ setup: 'npm ci' });
    await provisionTicketSandbox(sbx.deps, 7, { background: true });
    expect(sbx.windows).toHaveLength(2);
  });

  it('docker with a live turn is not started: a bounded wait, then the deferred refusal', async () => {
    const r = rig({ setup: 'npm ci', docker: true, turn: true });
    let t = 0;
    const out = await provisionTicketSandbox({ ...r.deps, now: () => t, sleep: async () => { t += 20 * 60_000; } }, 7);
    expect(out).toEqual({ ok: false, reason: 'sandbox setup deferred: agent turn active' });
    expect(r.windows).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it('no setup declared: nothing runs', async () => {
    const r = rig();
    expect(await provisionTicketSandbox(r.deps, 7)).toEqual({ ok: true });
    expect(r.ran).toHaveLength(0);
  });

  it('host ticket (no sandbox gate runner): nothing runs', async () => {
    const r = rig({ setup: 'npm ci', sandboxed: false });
    expect(await provisionTicketSandbox(r.deps, 7)).toEqual({ ok: true });
  });

  it('declared setup runs in the sandbox, silently when it passes', async () => {
    const r = rig({ setup: 'npm ci' });
    expect(await provisionTicketSandbox(r.deps, 7)).toEqual({ ok: true });
    expect(r.ran.some((a) => a[1]?.includes('exec sh -c'))).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('a failed setup refuses with the reason and notifies exactly once', async () => {
    const r = rig({ setup: 'npm ci', exit: 1 });
    const out = await provisionTicketSandbox(r.deps, 7);
    expect(out).toMatchObject({ ok: false });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Karst: T7 sandbox setup failed: sandbox dependencies not provisioned: /);
  });

  it('matches a worktree to its repository by repoPath, and runs setup in that worktree', async () => {
    const r = rig({ setup: 'npm ci' });
    const cwds: string[] = [];
    const base = r.deps.gateProcess(7)!;
    const deps = { ...r.deps, worktrees: () => [{ repo: '/repo', path: '/wt-by-path' }], gateProcess: () => (async (c, a, cwd, ...rest) => { cwds.push(cwd); return base(c, a, cwd, ...rest); }) as GateProcessRunner };
    await provisionTicketSandbox(deps, 7);
    expect(cwds.length).toBeGreaterThan(0);
    expect(new Set(cwds)).toEqual(new Set(['/wt-by-path']));
  });

  it('a worktree of an unknown repository, or no manifest, runs nothing', async () => {
    const r = rig({ setup: 'npm ci' });
    expect(await provisionTicketSandbox({ ...r.deps, worktrees: () => [{ repo: 'other', path: '/w' }] }, 7)).toEqual({ ok: true });
    expect(await provisionTicketSandbox({ ...r.deps, manifest: () => undefined }, 7)).toEqual({ ok: true });
    expect(r.ran).toHaveLength(0);
  });

  it('no bridge dir: no step', async () => {
    const r = rig({ setup: 'npm ci' });
    expect(await provisionTicketSandbox({ ...r.deps, bridgeOf: () => undefined }, 7)).toEqual({ ok: true });
    expect(r.ran).toHaveLength(0);
  });

  it('a second repository records in its own state file; only the first owns the failure log', async () => {
    const r = rig({ setup: 'npm ci', exit: 1 });
    const m = buildManifest({ app: repo({ repoPath: '/a', sandbox: { setup: 'npm ci' } }), web: repo({ repoPath: '/w', sandbox: { setup: 'npm ci' } }) });
    const ok = (): Promise<{ kind: 'completed'; exitCode: number; output: string; stdout: string }> => Promise.resolve({ kind: 'completed', exitCode: 0, output: HASH, stdout: HASH });
    const runGate: GateProcessRunner = (_c, args) => (args[1]?.includes('command -v node') || r.ran.length > 0 ? ok() : (r.ran.push([]), Promise.resolve({ kind: 'completed', exitCode: 0, output: '', stdout: '' })));
    const deps: TicketSetupDeps = { ...r.deps, manifest: () => m, gateProcess: () => runGate, worktrees: () => [{ repo: 'app', path: '/a' }, { repo: 'web', path: '/w' }] };
    expect(await provisionTicketSandbox(deps, 7)).toEqual({ ok: true });
    expect(existsSync(r.paths.setupStateFile)).toBe(true);
    expect(existsSync(r.paths.setupStateFile.replace(/\.setup\.json$/, '.web.setup.json'))).toBe(true);
  });

  it('the first failing repository stops the rest and is logged', async () => {
    const r = rig({ setup: 'npm ci', exit: 1 });
    const m = buildManifest({ app: repo({ sandbox: { setup: 'a' } }), web: repo({ sandbox: { setup: 'b' } }) });
    const logs: string[] = [];
    const deps: TicketSetupDeps = { ...r.deps, manifest: () => m, debug: (x) => logs.push(x), worktrees: () => [{ repo: 'app', path: '/a' }, { repo: 'web', path: '/w' }] };
    await provisionTicketSandbox(deps, 7);
    expect(r.errors).toHaveLength(1);
    expect(logs.some((l) => l.startsWith('[sandbox] ticket 7 app: '))).toBe(true);
    expect(existsSync(r.paths.setupStateFile.replace(/\.setup\.json$/, '.web.setup.json'))).toBe(false);
  });

  it('only the first repository owns setup.log; a later failure does not write it', async () => {
    const r = rig();
    const m = buildManifest({ app: repo({ sandbox: { setup: 'a' } }), web: repo({ sandbox: { setup: 'b' } }) });
    const runGate: GateProcessRunner = (_c, args, cwd) => {
      const fp = args[1]?.includes('command -v node');
      return Promise.resolve({ kind: 'completed', exitCode: fp || cwd !== '/w' ? 0 : 1, output: fp ? HASH : 'boom', stdout: fp ? HASH : '' });
    };
    const deps: TicketSetupDeps = { ...r.deps, manifest: () => m, gateProcess: () => runGate, worktrees: () => [{ repo: 'app', path: '/a' }, { repo: 'web', path: '/w' }] };
    expect(await provisionTicketSandbox(deps, 7)).toMatchObject({ ok: false });
    expect(existsSync(r.paths.setupLogFile)).toBe(false);
    resetSetupLocks();
    const failFirst = rig({ setup: 'npm ci', exit: 1 });
    await provisionTicketSandbox(failFirst.deps, 7);
    expect(readFileSync(failFirst.paths.setupLogFile, 'utf8')).toContain('npm ci');
  });

  it('passes the clock, debug sink and abort signal through to the setup run', async () => {
    const r = rig({ setup: 'npm ci', exit: 1 });
    const seen: (AbortSignal | undefined)[] = [];
    const base = r.deps.gateProcess(7)!;
    const logs: string[] = [];
    const ctl = new AbortController();
    const deps: TicketSetupDeps = { ...r.deps, now: () => 4242, debug: (x) => logs.push(x), gateProcess: () => ((c, a, cwd, o) => { seen.push(o?.signal); return base(c, a, cwd, o); }) as GateProcessRunner };
    await provisionTicketSandbox(deps, 7, { signal: ctl.signal });
    expect(JSON.parse(readFileSync(r.paths.setupStateFile, 'utf8'))).toMatchObject({ at: 4242, status: 'failed' });
    expect(logs.some((l) => l.startsWith('[sandbox] setup failed'))).toBe(true);
    expect(seen).toContain(ctl.signal);
  });

  it('concurrent calls for one ticket and repository share one setup run', async () => {
    const r = rig({ setup: 'npm ci' });
    await Promise.all([provisionTicketSandbox(r.deps, 7), provisionTicketSandbox(r.deps, 7)]);
    expect(r.ran.filter((a) => a[1]?.includes('exec sh -c'))).toHaveLength(1);
  });
});

describe('clearSetupState', () => {
  it("removes this ticket's setup records (all repos) and nothing else", async () => {
    const paths = bridgePaths(mkdtempSync(join(tmpdir(), 'clr-')), 7);
    const dir = join(paths.setupStateFile, '..');
    mkdirSync(dir, { recursive: true });
    const mine = ['7.setup.json', '7.web.setup.json'];
    const keep = ['70.setup.json', '8.setup.json', '7.json', '7.marker.json'];
    for (const n of [...mine, ...keep]) writeFileSync(join(dir, n), '{}');
    await clearSetupState(paths);
    expect(mine.map((n) => existsSync(join(dir, n)))).toEqual([false, false]);
    expect(keep.map((n) => existsSync(join(dir, n)))).toEqual([true, true, true, true]);
  });
  it('tolerates a missing state dir', async () => {
    await expect(clearSetupState(bridgePaths(join(tmpdir(), 'no-such-root-x'), 7))).resolves.toBeUndefined();
  });

  describe('failure buttons', () => {
    const withButtons = (exit: number, pick: string | undefined) => {
      const r = rig({ setup: 'npm ci', exit });
      const calls: string[] = [];
      const offered: string[][] = [];
      const deps: TicketSetupDeps = {
        ...r.deps, sleep: async () => undefined,
        notify: { ...r.deps.notify, errorActions: async (_m, a) => { offered.push([...a]); return pick; } },
        actions: { rerun: async (id) => { calls.push(`rerun ${id}`); }, openLog: (p) => { calls.push(`log ${p}`); }, memoryHelp: () => { calls.push('help'); } },
      };
      return { r, deps, calls, offered };
    };
    const settle = () => new Promise((res) => setTimeout(res, 5));

    it('a kill offers Re-run setup, Show setup log and Docker memory help', async () => {
      const x = withButtons(137, undefined);
      await provisionTicketSandbox(x.deps, 7);
      expect(x.offered).toEqual([['Re-run setup', 'Show setup log', 'Docker memory help']]);
    });

    it('another failure offers no memory help', async () => {
      const x = withButtons(1, undefined);
      await provisionTicketSandbox(x.deps, 7);
      expect(x.offered).toEqual([['Re-run setup', 'Show setup log']]);
    });

    it('dismissing the notification runs no action', async () => {
      const x = withButtons(137, undefined);
      await provisionTicketSandbox(x.deps, 7); await settle();
      expect(x.calls).toEqual([]);
    });

    it('the kill context of the ticket lands in the failure reason', async () => {
      const x = withButtons(137, undefined);
      const r = await provisionTicketSandbox({ ...x.deps, killContextOf: () => async () => 'Docker VM 4.8 GB' }, 7);
      expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('likely out of memory (Docker VM 4.8 GB)') });
    });

    it('a throwing action without a debug sink does not escape', async () => {
      const x = withButtons(1, 'Re-run setup');
      await provisionTicketSandbox({ ...x.deps, actions: { rerun: async () => { throw new Error('nope'); }, openLog: () => undefined, memoryHelp: () => undefined } }, 7);
      await settle();
      expect(x.calls).toEqual([]);
    });

    it('a throwing action is logged, never unhandled', async () => {
      const debug: string[] = [];
      const x = withButtons(1, 'Re-run setup');
      await provisionTicketSandbox({ ...x.deps, debug: (m) => { debug.push(m); }, actions: { rerun: async () => { throw new Error('nope'); }, openLog: () => undefined, memoryHelp: () => undefined } }, 7);
      await settle();
      expect(debug).toContain('[sandbox] setup failure action failed: nope');
    });

    it('Re-run setup re-runs and re-drives; Show setup log opens the log; help explains', async () => {
      const a = withButtons(1, 'Re-run setup');
      await provisionTicketSandbox(a.deps, 7); await settle();
      expect(a.calls).toEqual(['rerun 7']);
      resetSetupLocks();
      const b = withButtons(1, 'Show setup log');
      await provisionTicketSandbox(b.deps, 7); await settle();
      expect(b.calls).toEqual([`log ${b.r.paths.setupLogFile}`]);
      resetSetupLocks();
      const c = withButtons(137, 'Docker memory help');
      await provisionTicketSandbox(c.deps, 7); await settle();
      expect(c.calls).toEqual(['help']);
    });
  });
});
