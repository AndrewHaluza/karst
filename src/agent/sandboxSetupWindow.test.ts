import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GateProcessRunner, ProcessOutcome } from '../workflow/gates/run.js';
import { DEFAULT_SETUP_HOSTS, setupHostError, setupHostsOf } from '../manifest/sandboxSetupHosts.js';
import { ensureSandboxSetup, resetSetupLocks, type SetupDeps, type SetupWindowPort } from './sandboxSetup.js';
import { createSbxSessionRunner } from './sbx/sbxRunner.js';
import { fakeSbxProcess } from './sbx/fakeSbxProcess.js';
import { createDockerSessionRunner } from './docker/dockerRunner.js';
import { dockerNames } from './docker/dockerNames.js';
import { fakeDockerProcess } from './docker/fakeDockerProcess.js';
import { DOCKER_ALLOWLIST } from './docker/proxySidecar.js';

const HASH = 'b'.repeat(64);
const done = (output = '', exitCode = 0): ProcessOutcome => ({ kind: 'completed', exitCode, output, stdout: output });
const req = { key: 'w1', setup: 'npm ci', cwd: '/clone', hosts: ['registry.npmjs.org'] };

function rig(order: string[], setupOut: ProcessOutcome, window: SetupWindowPort, over: Partial<SetupDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'setupwin-'));
  const runGate: GateProcessRunner = async (_c, args) => {
    if (args[1]?.includes('command -v node')) return done(HASH);
    if (args[1]?.includes('exec sh')) { order.push('setup'); return setupOut; }
    return done();
  };
  const stateFile = join(dir, '1.setup.json');
  return { deps: { runGate, stateFile, window, ...over } as SetupDeps, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as { status: string } };
}
const port = (order: string[], over: Partial<SetupWindowPort> = {}): SetupWindowPort => ({
  needsIdle: false, turnActive: () => false,
  open: async () => { order.push('open'); return { ok: true, close: async () => { order.push('close'); } }; },
  ...over,
});

describe('setup network window', () => {
  beforeEach(() => resetSetupLocks());

  it('opens before the setup and closes after it', async () => {
    const order: string[] = [];
    const r = rig(order, done(), port(order));
    await expect(ensureSandboxSetup({ ...r.deps }, req)).resolves.toEqual({ ok: true });
    expect(order).toEqual(['open', 'setup', 'close']);
  });

  it('closes after a failed setup and names a blocked host', async () => {
    const order: string[] = [];
    const r = rig(order, done('npm ERR! request to https://x failed\nnpm ERR! code ENOTFOUND evil.example.com', 1), port(order));
    const res = await ensureSandboxSetup(r.deps, req);
    expect(res).toMatchObject({ ok: false });
    expect(res.ok ? '' : res.reason).toContain('blocked host evil.example.com');
    expect(order).toEqual(['open', 'setup', 'close']);
  });

  it('closes after an aborted setup', async () => {
    const order: string[] = [];
    const r = rig(order, { kind: 'aborted', output: '' } as ProcessOutcome, port(order));
    await ensureSandboxSetup(r.deps, req);
    expect(order).toEqual(['open', 'setup', 'close']);
  });

  it('does not run the setup when the window cannot open', async () => {
    const order: string[] = [];
    const r = rig(order, done(), port(order, { open: async () => ({ ok: false, reason: 'nope' }) }));
    const res = await ensureSandboxSetup(r.deps, req);
    expect(res.ok ? '' : res.reason).toContain('could not open the setup network window: nope');
    expect(order).toEqual([]);
    expect(r.state().status).toBe('failed');
  });

  it('docker: defers while a turn is active, then runs once idle', async () => {
    const order: string[] = [];
    let active = 3;
    const r = rig(order, done(), port(order, { needsIdle: true, turnActive: () => active-- > 0 }), { sleep: async () => { order.push('wait'); } });
    await ensureSandboxSetup(r.deps, req);
    expect(order).toEqual(['wait', 'wait', 'open', 'setup', 'close']);
  });

  it('docker: refuses with the deferred reason when the turn outlasts the bound, no window opened', async () => {
    const order: string[] = [];
    let t = 0;
    const r = rig(order, done(), port(order, { needsIdle: true, turnActive: () => true }), { now: () => t, sleep: async () => { t += 60_000; }, boundMs: 120_000 });
    const res = await ensureSandboxSetup(r.deps, req);
    expect(res).toEqual({ ok: false, reason: 'sandbox setup deferred: agent turn active' });
    expect(order).toEqual([]);
    expect(r.state().status).toBe('deferred');
  });

  it('sbx: opens and closes during an active turn without deferring', async () => {
    const order: string[] = [];
    const r = rig(order, done(), port(order, { needsIdle: false, turnActive: () => true }));
    await ensureSandboxSetup(r.deps, req);
    expect(order).toEqual(['open', 'setup', 'close']);
  });
});

describe('setup hosts', () => {
  it('defaults and validates', () => {
    expect(setupHostsOf(undefined)).toEqual(DEFAULT_SETUP_HOSTS);
    expect(setupHostsOf([])).toEqual(DEFAULT_SETUP_HOSTS);
    expect(setupHostsOf(['a.io'])).toEqual(['a.io']);
    expect(DEFAULT_SETUP_HOSTS).toEqual(['registry.npmjs.org', 'github.com', 'objects.githubusercontent.com']);
    for (const ok of ['registry.npmjs.org', '*.githubusercontent.com', 'localhost']) expect(setupHostError(ok)).toBeUndefined();
    for (const bad of ['a b', 'x:443', 'https://x.io', '-x.io', 'host.docker.internal', '*', 'a,b']) expect(setupHostError(bad)).toBeDefined();
  });
});

describe('sbx setupWindow', () => {
  const NAME = 'karst-ab12cd34-7-claude';
  const calls = (p: ReturnType<typeof fakeSbxProcess>) => p.calls.map((c) => c.args.join(' '));

  it('allows then removes exactly the same resources', async () => {
    const proc = fakeSbxProcess();
    const w = await createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] }).setupWindow!(['registry.npmjs.org', '*.github.com']);
    expect(w.ok).toBe(true);
    if (w.ok) await w.close();
    expect(calls(proc).slice(1)).toEqual([
      `policy allow network --sandbox ${NAME} registry.npmjs.org:443,*.github.com:443`,
      `policy rm network --sandbox ${NAME} registry.npmjs.org:443,*.github.com:443`,
    ]);
  });

  it('records and removes only the hosts not already allowed (overlap with the baseline survives)', async () => {
    const proc = fakeSbxProcess({ 'sbx policy ls': { stdout: `allow  network  registry.npmjs.org:443\nallow network host.docker.internal:5432\n` } });
    const w = await createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] }).setupWindow!(['registry.npmjs.org', 'github.com']);
    if (w.ok) await w.close();
    expect(calls(proc).slice(1)).toEqual([
      `policy allow network --sandbox ${NAME} github.com:443`,
      `policy rm network --sandbox ${NAME} github.com:443`,
    ]);
  });

  it('everything already allowed: nothing opened, nothing removed', async () => {
    const proc = fakeSbxProcess({ 'sbx policy ls': { stdout: 'registry.npmjs.org:443' } });
    const w = await createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] }).setupWindow!(['registry.npmjs.org']);
    if (w.ok) await w.close();
    expect(calls(proc)).toHaveLength(1);
  });

  it('a failed allow is rolled back and reported', async () => {
    const proc = fakeSbxProcess({ 'sbx policy allow': { code: 1, stderr: 'denied' } });
    const w = await createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] }).setupWindow!(['github.com']);
    expect(w).toEqual({ ok: false, reason: 'sbx policy allow failed: denied' });
    expect(calls(proc).some((c) => c.startsWith('policy rm'))).toBe(true);
  });

  it('refuses an invalid host before touching sbx', async () => {
    const proc = fakeSbxProcess();
    await expect(createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] }).setupWindow!(['bad host'])).rejects.toThrow(/not a host name/);
  });
});

describe('docker setupWindow', () => {
  const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' });
  const runner = (proc: ReturnType<typeof fakeDockerProcess>) =>
    createDockerSessionRunner({ proc, core: 'opencode', names, user: undefined, proxy: { script: '/s/p.mjs', hostPorts: [5432] } });
  const runs = (proc: ReturnType<typeof fakeDockerProcess>) => proc.calls.map((c) => c.args.join(' ')).filter((l) => l.startsWith('run '));

  it('needs an idle agent', () => {
    expect(runner(fakeDockerProcess()).windowNeedsIdle).toBe(true);
  });

  it('proxy env has the hosts only during the window, the baseline after', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { code: 1 } });
    const w = await runner(proc).setupWindow!(['registry.npmjs.org', '*.github.com']);
    expect(w.ok).toBe(true);
    expect(runs(proc)[0]).toContain(`ALLOW=${[...DOCKER_ALLOWLIST, 'registry.npmjs.org', 'github.com'].join(',')}`);
    expect(runs(proc)[0]).toContain('ALLOW_HOSTPORTS=host.docker.internal:5432');
    if (w.ok) await w.close();
    expect(runs(proc)[1]).toContain(`ALLOW=${DOCKER_ALLOWLIST.join(',')}`);
    expect(runs(proc)[1]).toContain('ALLOW_HOSTPORTS=host.docker.internal:5432');
    expect(runs(proc)[1]).not.toContain('karst.allow=');
  });

  it('a failed open restores the baseline proxy', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { code: 1 }, 'docker run': { code: 1, stderr: 'boom' } });
    const w = await runner(proc).setupWindow!(['github.com']);
    expect(w.ok).toBe(false);
    expect(runs(proc)).toHaveLength(2);
  });

  it('no proxy config: refuses', async () => {
    const r = createDockerSessionRunner({ proc: fakeDockerProcess(), core: 'opencode', names, user: undefined });
    expect((await r.setupWindow!(['a.io'])).ok).toBe(false);
  });
});
