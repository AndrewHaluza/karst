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

function rig(opts: { setup?: string; exit?: number; sandboxed?: boolean } = {}) {
  const errors: string[] = [];
  const ran: string[][] = [];
  const runGate: GateProcessRunner = async (_c, args) => {
    ran.push([...args]);
    const fp = args[1]?.startsWith('node -e');
    return { kind: 'completed', exitCode: fp ? 0 : (opts.exit ?? 0), output: fp ? HASH : 'boom', stdout: fp ? HASH : '' };
  };
  const repoKey = 'app';
  const manifest = buildManifest({ [repoKey]: repo(opts.setup ? { sandbox: { setup: opts.setup } } : {}) });
  const paths = bridgePaths(mkdtempSync(join(tmpdir(), 'op-')), 7);
  const deps: TicketSetupDeps = {
    manifest: () => manifest, worktrees: () => [{ repo: repoKey, path: '/wt' }], gateProcess: () => (opts.sandboxed === false ? undefined : runGate),
    bridgeOf: () => paths, ticketLabel: () => 'T7', notify: { info: () => undefined, warn: () => undefined, error: (m) => { errors.push(m); return Promise.resolve(); } },
  };
  return { deps, errors, ran, paths, manifest };
}

describe('provisionTicketSandbox', () => {
  beforeEach(() => resetSetupLocks());

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
    const runGate: GateProcessRunner = (_c, args) => (args[1]?.startsWith('node -e') || r.ran.length > 0 ? ok() : (r.ran.push([]), Promise.resolve({ kind: 'completed', exitCode: 0, output: '', stdout: '' })));
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
      const fp = args[1]?.startsWith('node -e');
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
});
