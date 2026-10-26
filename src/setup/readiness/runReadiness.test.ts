import { describe, it, expect } from 'vitest';
import { coresUsed, runReadiness, type ReadinessInput } from './runReadiness.js';
import { fakeProbes } from './fakeProbes.testutil.js';
import type { Manifest } from '../../manifest/types.js';

const manifest = (extra: Record<string, unknown> = {}, repo: Record<string, unknown> = {}): Manifest =>
  ({
    host: '127.0.0.1',
    portRange: [3000, 3999],
    baselineBranch: 'main',
    repositories: { web: { repoPath: '/w/web', hasMigrations: false, ...repo } },
    ...extra,
  }) as unknown as Manifest;
const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  manifest: manifest(), warnings: [], repos: [], probes: fakeProbes(), ...over,
});
const find = (r: { items: { id: string; status: string; detail: string }[] }, id: string) => r.items.find((x) => x.id === id);

describe('coresUsed', () => {
  it('defaults to claude', () => expect(coresUsed(manifest())).toEqual(['claude']));
  it('unions default, processes and preset slots', () => {
    const m = manifest({
      agentProvider: 'codex',
      processes: { review: { provider: 'opencode' } },
      agentPresets: { p: { slots: { planning: { provider: 'claude', model: 'm' } } } },
    });
    expect(coresUsed(m).sort()).toEqual(['claude', 'codex', 'opencode']);
  });
});

describe('runReadiness', () => {
  it('all green is ok', async () => {
    const r = await runReadiness(input());
    expect(r.ok).toBe(true);
    expect(find(r, 'services')!.status).toBe('ok');
    expect(find(r, 'core.claude')!.status).toBe('ok');
  });
  it('load error is a single fail', async () => {
    const r = await runReadiness(input({ manifest: undefined, loadError: 'bad yaml' }));
    expect(r).toMatchObject({ ok: false, items: [{ id: 'manifest.load', status: 'fail', detail: 'bad yaml' }] });
  });
  it('load error without message still reports', async () => {
    const r = await runReadiness(input({ manifest: undefined }));
    expect(r.items[0]!.detail).toBe('manifest could not be loaded');
  });
  it('every warning is a fail', async () => {
    const r = await runReadiness(input({ warnings: ['a', 'b'] }));
    expect(r.ok).toBe(false);
    expect(find(r, 'manifest.warning.0')).toMatchObject({ status: 'fail', detail: 'a' });
    expect(find(r, 'manifest.warning.1')!.status).toBe('fail');
  });
  it('--repos filters and flags unknown names', async () => {
    const m = manifest();
    m.repositories.api = { repoPath: '/w/api', hasMigrations: false } as never;
    const r = await runReadiness(input({ manifest: m, repos: ['web', 'nope'] }));
    expect(find(r, 'repo.git.web')).toBeDefined();
    expect(find(r, 'repo.git.api')).toBeUndefined();
    expect(find(r, 'repo.unknown.nope')!.status).toBe('fail');
  });
  it('disabled repos are skipped', async () => {
    const r = await runReadiness(input({ manifest: manifest({}, { enabled: false }) }));
    expect(find(r, 'repo.git.web')).toBeUndefined();
  });
  it('services declared without a verifier warns and stays ok', async () => {
    const r = await runReadiness(input({ manifest: manifest({}, { service: { command: 'x' } }) }));
    expect(find(r, 'services')!.status).toBe('warn');
    expect(r.ok).toBe(true);
  });
  it('services verifier pass and fail', async () => {
    const m = manifest({}, { service: { command: 'x' } });
    const pass = await runReadiness(input({ manifest: m, verifyServices: async () => ({ ok: true, failed: [] }) }));
    expect(find(pass, 'services')!.status).toBe('ok');
    const bad = await runReadiness(input({ manifest: m, verifyServices: async () => ({ ok: false, failed: ['web'] }) }));
    expect(find(bad, 'services')).toMatchObject({ status: 'fail', detail: 'setup verify failed for web' });
    const err = await runReadiness(input({ manifest: m, verifyServices: async () => ({ ok: false, error: 'boom', failed: [] }) }));
    expect(find(err, 'services')!.detail).toBe('boom');
  });
  it('missing and not-ready cores fail with a fix', async () => {
    const miss = await runReadiness(input({ probes: fakeProbes({ coreState: () => 'missing' }) }));
    expect(find(miss, 'core.claude')!.status).toBe('fail');
    const nr = await runReadiness(input({ probes: fakeProbes({ coreState: () => 'not-ready' }) }));
    expect(find(nr, 'core.claude')).toMatchObject({ status: 'fail' });
    expect(nr.ok).toBe(false);
  });
});
