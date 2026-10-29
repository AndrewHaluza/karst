import { describe, expect, it } from 'vitest';
import { SANDBOX_DISK_WARN_BYTES, checkSandboxBackends, checkSandboxSetupDeclared, parseDockerSize, type SetupRepoFact } from './sandboxChecks.js';

const OK = { ok: true } as const;
const base = { selected: ['sbx'], sbx: OK, docker: OK, sandboxCount: 0, diskBytes: undefined } as const;

describe('checkSandboxBackends', () => {
  it('emits nothing when no backend is selected', () => {
    expect(checkSandboxBackends({ ...base, selected: [] })).toEqual([]);
  });
  it('reports the selected backend ok', () => {
    const [c] = checkSandboxBackends(base);
    expect(c).toMatchObject({ id: 'tools.sandbox-sbx', area: 'tools', status: 'ok' });
  });
  it('warns with the reason as the fix hint when unavailable', () => {
    const [c] = checkSandboxBackends({ ...base, sbx: { ok: false, reason: 'sbx not signed in (run `sbx login`)' } });
    expect(c).toMatchObject({ status: 'warn', fix: { tier: 'report', nextStep: 'sbx not signed in (run `sbx login`)' } });
    expect(c!.detail).toContain('prompted on host');
  });
  it('checks only the selected backend', () => {
    const ids = checkSandboxBackends({ ...base, selected: ['docker'], sbx: { ok: false, reason: 'x' } }).map((c) => c.id);
    expect(ids).toEqual(['tools.sandbox-docker']);
  });
  it('checks both backends when sbx and docker are both selected', () => {
    const out = checkSandboxBackends({ ...base, selected: ['sbx', 'docker'], docker: { ok: false, reason: 'docker not installed' } });
    expect(out.map((c) => [c.id, c.status])).toEqual([['tools.sandbox-sbx', 'ok'], ['tools.sandbox-docker', 'warn']]);
  });
  it('shows sandbox count and size, ok under the threshold', () => {
    const c = checkSandboxBackends({ ...base, sandboxCount: 3, diskBytes: 2e9 }).find((x) => x.id === 'state.sandbox-disk');
    expect(c).toMatchObject({ status: 'ok' });
    expect(c!.detail).toContain('3 sandboxes');
    expect(c!.detail).toContain('2.0 GB');
  });
  it('warns above 10 GB', () => {
    const c = checkSandboxBackends({ ...base, sandboxCount: 1, diskBytes: SANDBOX_DISK_WARN_BYTES + 1 }).find((x) => x.id === 'state.sandbox-disk');
    expect(c).toMatchObject({ status: 'warn' });
  });
  it('exactly 10 GB does not warn', () => {
    expect(checkSandboxBackends({ ...base, sandboxCount: 1, diskBytes: SANDBOX_DISK_WARN_BYTES }).find((x) => x.id === 'state.sandbox-disk')!.status).toBe('ok');
  });
  it('unknown size still reports the count', () => {
    const c = checkSandboxBackends({ ...base, sandboxCount: 1 }).find((x) => x.id === 'state.sandbox-disk');
    expect(c!.detail).toContain('1 sandbox,');
    expect(c!.detail).toContain('size unknown');
  });
  it('skips the disk line when there are no sandboxes', () => {
    expect(checkSandboxBackends(base).some((x) => x.id === 'state.sandbox-disk')).toBe(false);
  });
});

describe('parseDockerSize', () => {
  it.each([['12.3MB (virtual 1.2GB)', 12.3e6], ['0B', 0], ['2GB', 2e9], ['500kB', 500e3], ['1.5TB', 1.5e12]])('%s', (s, n) => {
    expect(parseDockerSize(s)).toBeCloseTo(n, -3);
  });
  it('rejects garbage', () => {
    expect(parseDockerSize('lots')).toBeUndefined();
  });
  it('warns report-only when the Docker VM has under 8 GB, ok at 8 GB', () => {
    const low = checkSandboxBackends({ ...base, selected: ['docker'], dockerMemBytes: 4.8 * 2 ** 30 }).find((c) => c.id === 'tools.docker-memory');
    expect(low).toMatchObject({ status: 'warn', fix: { tier: 'report' } });
    const ok = checkSandboxBackends({ ...base, selected: ['docker'], dockerMemBytes: 8 * 2 ** 30 }).find((c) => c.id === 'tools.docker-memory');
    expect(ok?.status).toBe('ok');
    expect(ok).toMatchObject({ area: 'tools', detail: 'Docker VM memory 8.0 GB' });
    expect(ok?.fix).toBeUndefined();
    expect(low?.detail).toBe('Docker VM memory 4.8 GB');
    expect(JSON.stringify(low?.fix)).toContain('Memory');
    const just = checkSandboxBackends({ ...base, selected: ['docker'], dockerMemBytes: 8 * 2 ** 30 - 1 }).find((c) => c.id === 'tools.docker-memory');
    expect(just?.status).toBe('warn');
  });
  it('no memory check without docker selected or an unknown size', () => {
    expect(checkSandboxBackends({ ...base, dockerMemBytes: 1 * 2 ** 30 }).some((c) => c.id === 'tools.docker-memory')).toBe(false);
    expect(checkSandboxBackends({ ...base, selected: ['docker'] }).some((c) => c.id === 'tools.docker-memory')).toBe(false);
  });
});

describe('checkSandboxSetupDeclared', () => {
  const repo = (o: Partial<SetupRepoFact> = {}): SetupRepoFact => ({ name: 'app', hasLockfile: true, hasSetup: false, ...o });
  it('warns naming the repo and the suggested setup', () => {
    const [c] = checkSandboxSetupDeclared(['sbx'], [repo()]);
    expect(c).toMatchObject({ id: 'manifest.sandbox-setup.app', area: 'manifest', status: 'warn' });
    expect(c!.detail).toContain('app');
    expect(c!.fix).toMatchObject({ tier: 'report' });
    expect(c!.fix!.nextStep).toContain('sandbox.setup: npm ci');
  });
  it.each([[{ hasSetup: true }], [{ hasLockfile: false }]])('is silent for %o', (o) => {
    expect(checkSandboxSetupDeclared(['docker'], [repo(o)])).toEqual([]);
  });
  it('is silent without a sandbox backend', () => {
    expect(checkSandboxSetupDeclared([], [repo()])).toEqual([]);
  });
});
