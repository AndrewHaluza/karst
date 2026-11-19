import { describe, it, expect } from 'vitest';
import { coresUsed, coresOptional, runReadiness, type ReadinessInput } from './runReadiness.js';
import { fakeProbes } from './fakeProbes.testutil.js';
import { BUILT_IN_PACKAGE_ID } from '../../approaches/builtInId.js';
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
  it('unions default, processes and active preset slots', () => {
    const m = manifest({
      agentProvider: 'codex',
      processes: { review: { provider: 'opencode' } },
      activeAgentPreset: 'p',
      agentPresets: { p: { slots: { planning: { provider: 'claude', model: 'm' } } } },
    });
    expect(coresUsed(m).sort()).toEqual(['claude', 'codex', 'opencode']);
  });
});

describe('coresUsed graph and preset rules', () => {
  const graph = (enabled: boolean) => ({
    approaches: [{ id: 'g', label: 'g', enabled, graph: { profiles: { expert: { provider: 'claude', model: 'm' } } } }],
  });
  it('lists claude when only an enabled graph profile uses it', () => {
    expect(coresUsed(manifest({ agentProvider: 'codex', ...graph(true) })).sort()).toEqual(['claude', 'codex']);
  });
  it('lists claude for the packaged graph approach when the default core is codex', () => {
    expect(coresUsed(manifest({ agentProvider: 'codex' })).sort()).toEqual(['claude', 'codex']);
  });
  it('ignores a disabled graph approach', () => {
    const off = { approaches: [{ id: BUILT_IN_PACKAGE_ID, label: 'b', enabled: false }, ...graph(false).approaches] };
    expect(coresUsed(manifest({ agentProvider: 'codex', ...off }))).toEqual(['codex']);
  });
  it('counts only the active preset as required', () => {
    const m = manifest({
      agentProvider: 'codex',
      activeAgentPreset: 'a',
      agentPresets: {
        a: { slots: { graphExpert: { provider: 'opencode', model: 'm' } } },
        b: { slots: { review: { provider: 'antigravity', model: 'm' } } },
      },
    });
    expect(coresUsed(m).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(coresOptional(m)).toEqual(['antigravity']);
  });
  it('reports a missing optional core as a warning, not a failure', async () => {
    const m = manifest({ agentPresets: { b: { slots: { review: { provider: 'codex', model: 'm' } } } } });
    const r = await runReadiness(input({ manifest: m, probes: fakeProbes({ coreState: (p: string) => (p === 'codex' ? 'missing' : 'ok') }) }));
    expect(find(r, 'core.codex')!.status).toBe('warn');
    expect(r.ok).toBe(true);
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
  it('every warning is a fail, with the id of its code', async () => {
    const r = await runReadiness(
      input({
        warnings: [
          { code: 'manifest.legacy-services', message: 'a' },
          { code: 'manifest.retired-key.confirmGeneratedGraph', message: 'b' },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(find(r, 'manifest.legacy-services')).toMatchObject({ status: 'fail', detail: 'a' });
    expect(find(r, 'manifest.retired-key.confirmGeneratedGraph')!.status).toBe('fail');
  });
  it('a warning id does not move when an earlier warning goes away', async () => {
    const retired = { code: 'manifest.retired-key.confirmGeneratedGraph', message: 'b' };
    const both = await runReadiness(input({ warnings: [{ code: 'manifest.legacy-services', message: 'a' }, retired] }));
    const one = await runReadiness(input({ warnings: [retired] }));
    expect(find(both, retired.code)).toEqual(find(one, retired.code));
  });
  it('two warnings with the same code get distinct ids', async () => {
    const w = { code: 'manifest.gate-pin.uat.gates.x', message: 'm' };
    const r = await runReadiness(input({ warnings: [w, w] }));
    const ids = r.items.filter((i) => i.id.startsWith(w.code)).map((i) => i.id);
    expect(ids).toEqual([w.code, `${w.code}#2`]);
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
