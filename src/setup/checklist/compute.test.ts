import { describe, it, expect } from 'vitest';
import { computeChecklist } from './compute.js';
import type { ChecklistItem, SkipRecord } from './types.js';
import { runReadiness, type ReadinessInput } from '../readiness/runReadiness.js';
import { fakeProbes } from '../readiness/fakeProbes.testutil.js';
import type { ReadinessProbes } from '../readiness/types.js';
import type { DiscoveredRepo, DiscoveryResult } from '../discover.js';
import type { Manifest } from '../../manifest/types.js';

const SERVICE = { start: 'npm run dev', health: 'http://{host}:{port}/health', ports: [{ name: 'http', env: 'PORT', default: 3000 }] };

const repo = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ repoPath: '/w/web', hasMigrations: false, ...over });
const manifestOf = (over: Record<string, unknown> = {}): Manifest =>
  ({ host: '127.0.0.1', portRange: [3000, 3999], baselineBranch: 'main', repositories: {}, ...over }) as unknown as Manifest;

const found = (name: string, path: string, runnable: boolean): DiscoveredRepo => ({
  name,
  path,
  baselineBranch: 'main',
  baselineBranchSource: 'origin-head',
  service: runnable ? { start: 'npm run dev', ports: [{ name: 'http', env: 'PORT', default: 3000 }], source: 'package.json' } : null,
  serviceReason: runnable ? '' : 'no start command',
});
const discovery = (...repos: DiscoveredRepo[]): DiscoveryResult => ({ repos, empty: repos.length === 0 });

async function run(
  manifest: Manifest | undefined,
  found_: DiscoveryResult | undefined,
  opts: { probes?: Partial<ReadinessProbes>; skips?: SkipRecord[]; verify?: ReadinessInput['verifyServices'] } = {},
): Promise<ChecklistItem[]> {
  const report = await runReadiness({ manifest, warnings: [], repos: [], probes: fakeProbes(opts.probes), verifyServices: 'verify' in opts ? opts.verify : async () => ({ ok: true, failed: [] }) });
  return computeChecklist({ manifest, discovery: found_, readiness: report.items, skips: opts.skips ?? [] });
}
const byCode = (items: readonly ChecklistItem[], code: string): ChecklistItem => items.find((i) => i.code === code)!;
const statuses = (items: readonly ChecklistItem[]): Record<string, string> => Object.fromEntries(items.map((i) => [i.code, i.status]));

const FULL = manifestOf({
  defaultModel: 'sonnet',
  repositories: { web: repo({ service: SERVICE }) },
  review: { gates: [{ name: 'lint', command: 'npm', args: ['run', '-s', 'gate:lint'] }], repositories: {} },
  uat: { gates: [{ name: 'e2e', command: 'npm', args: ['run', '-s', 'gate:e2e'] }], repositories: {} },
  ticketing: { provider: 'manual' },
  conventions: { branchName: '{type}/{slug}' },
  approaches: [{ id: 'a', label: 'A' }],
});

describe('computeChecklist: the list', () => {
  it('lists the items in a fixed order with a section, a tool and a flag each', async () => {
    const items = await run(FULL, discovery(found('web', '/w/web', true)));
    expect(items.map((i) => i.code)).toEqual([
      'repos.registered', 'repos.baseline', 'services.declared', 'quality.gates', 'agents.default',
      'ticketing.provider', 'git.conventions', 'uat.paths', 'approaches.enabled',
    ]);
    expect(items.map((i) => i.tool)).toEqual([
      'add-repo', 'set-general', 'set-service', 'set-quality', 'set-agents', 'set-ticketing', 'set-git', 'set-quality', 'set-approaches',
    ]);
    expect(items.filter((i) => i.required).map((i) => i.code)).toEqual([
      'repos.registered', 'repos.baseline', 'services.declared', 'quality.gates', 'agents.default',
    ]);
  });

  it('greenfield: no manifest, no repository: every item is todo', async () => {
    const items = await run(undefined, discovery());
    expect(new Set(items.map((i) => i.status))).toEqual(new Set(['todo']));
    expect(byCode(items, 'repos.registered').detail).toMatch(/karst\.yml does not exist/);
  });

  it('greenfield with a scaffold manifest and one discovered repo: the repo is not registered', async () => {
    const items = await run(manifestOf(), discovery(found('web', '/w/web', true)));
    const reg = byCode(items, 'repos.registered');
    expect(reg.status).toBe('todo');
    expect(reg.detail).toContain('web');
    expect(byCode(items, 'repos.baseline').status).toBe('todo');
    expect(byCode(items, 'agents.default').status).toBe('todo');
  });

  it('fully configured: every item is done and its readiness checks passed', async () => {
    const items = await run(FULL, discovery(found('web', '/w/web', true)));
    expect(statuses(items)).toEqual({
      'repos.registered': 'done', 'repos.baseline': 'done', 'services.declared': 'done', 'quality.gates': 'done',
      'agents.default': 'done', 'ticketing.provider': 'done', 'git.conventions': 'done', 'uat.paths': 'done', 'approaches.enabled': 'done',
    });
  });

  it('monorepo: apps that share one path are registered by path, not by name', async () => {
    const m = manifestOf({
      repositories: { web: repo({ repoPath: '/w/mono', service: SERVICE }), api: repo({ repoPath: '/w/mono' }) },
    });
    const items = await run(m, discovery(found('mono', '/w/mono', true)));
    expect(byCode(items, 'repos.registered').status).toBe('done');
    expect(byCode(items, 'services.declared').status).toBe('done');
  });

  it('monorepo: a second discovered repo that is not registered stays todo', async () => {
    const m = manifestOf({ repositories: { web: repo({ repoPath: '/w/mono', service: SERVICE }) } });
    const items = await run(m, discovery(found('mono', '/w/mono', true), found('docs', '/w/docs', false)));
    const reg = byCode(items, 'repos.registered');
    expect(reg.status).toBe('todo');
    expect(reg.detail).toContain('docs');
    expect(reg.detail).not.toContain('mono');
  });
});

describe('computeChecklist: done means verified', () => {
  it('repos.baseline stays todo while the baseline branch is missing, although the manifest names it', async () => {
    const items = await run(FULL, discovery(found('web', '/w/web', true)), { probes: { branchExists: () => false } });
    const item = byCode(items, 'repos.baseline');
    expect(item.status).toBe('todo');
    expect(item.detail).toContain('web');
  });

  it('repos.baseline stays todo while origin is missing', async () => {
    const items = await run(FULL, discovery(found('web', '/w/web', true)), { probes: { hasRemote: () => false } });
    expect(byCode(items, 'repos.baseline').status).toBe('todo');
  });

  it('repos.baseline is todo with no registered repository', async () => {
    const items = await run(manifestOf(), discovery());
    expect(byCode(items, 'repos.baseline').status).toBe('todo');
  });

  it('quality.gates is todo when a gate script is missing on the baseline', async () => {
    const items = await run(FULL, discovery(found('web', '/w/web', true)), { probes: { baseDefinesScript: async () => false } });
    const item = byCode(items, 'quality.gates');
    expect(item.status).toBe('todo');
    expect(item.detail).toContain('gates.script.review.gates[0]');
  });

  it('quality.gates is todo when no review gate is declared', async () => {
    const items = await run({ ...FULL, review: undefined } as Manifest, discovery(found('web', '/w/web', true)));
    expect(byCode(items, 'quality.gates').status).toBe('todo');
  });

  it('quality.gates counts a per-repository review gate as declared', async () => {
    const m = { ...FULL, review: { repositories: { web: { gates: [{ name: 'lint', command: 'npm', args: ['run', '-s', 'gate:lint'] }] } } } } as unknown as Manifest;
    const items = await run(m, discovery(found('web', '/w/web', true)));
    expect(byCode(items, 'quality.gates').status).toBe('done');
  });

  it('agents.default is todo while the core CLI is missing', async () => {
    const items = await run(FULL, discovery(found('web', '/w/web', true)), { probes: { coreState: () => 'missing' } });
    const item = byCode(items, 'agents.default');
    expect(item.status).toBe('todo');
    expect(item.detail).toContain('core.claude');
  });

  it('agents.default is todo while defaultModel is unset', async () => {
    const items = await run({ ...FULL, defaultModel: undefined } as Manifest, discovery(found('web', '/w/web', true)));
    const item = byCode(items, 'agents.default');
    expect(item.status).toBe('todo');
    expect(item.detail).toContain('defaultModel');
  });

  it('services.declared is todo until setup verify ran and passed', async () => {
    const m = manifestOf({ defaultModel: 'm', repositories: { web: repo({ service: SERVICE }) } });
    const d = discovery(found('web', '/w/web', true));
    const notRun = await run(m, d, { verify: undefined, skips: [] });
    expect(byCode(notRun, 'services.declared')).toMatchObject({ status: 'todo' });
    expect(byCode(notRun, 'services.declared').detail).toContain('setup verify');
    const failed = await run(m, d, { verify: async () => ({ ok: false, error: 'boom', failed: ['web'] }) });
    expect(byCode(failed, 'services.declared').status).toBe('todo');
    expect(byCode(await run(m, d), 'services.declared').status).toBe('done');
  });

  it('services.declared is todo when the service has no health', async () => {
    const m = manifestOf({ defaultModel: 'm', repositories: { web: repo({ service: { ...SERVICE, health: undefined } }) } });
    const items = await run(m, discovery(found('web', '/w/web', true)));
    expect(byCode(items, 'services.declared').status).toBe('todo');
  });

  it('services.declared is todo when the service has no ports', async () => {
    const m = manifestOf({ repositories: { web: repo({ service: { ...SERVICE, ports: [] } }) } });
    const items = await run(m, discovery(found('web', '/w/web', true)));
    expect(byCode(items, 'services.declared').status).toBe('todo');
  });

  it('services.declared accepts a services map entry with ports and health', async () => {
    const m = manifestOf({ repositories: { web: repo({ services: { app: SERVICE } }) } });
    const items = await run(m, discovery(found('web', '/w/web', true)));
    expect(byCode(items, 'services.declared').status).toBe('done');
  });

  it('services.declared is done when no discovered repository is runnable', async () => {
    const items = await run(manifestOf({ repositories: { lib: repo({ repoPath: '/w/lib' }) } }), discovery(found('lib', '/w/lib', false)));
    expect(byCode(items, 'services.declared').status).toBe('done');
  });

  it('services.declared is todo when the setup verify result is a fail', async () => {
    const report = await runReadiness({
      manifest: FULL, warnings: [], repos: [], probes: fakeProbes(),
      verifyServices: async () => ({ ok: false, failed: ['web'] }),
    });
    const items = computeChecklist({ manifest: FULL, discovery: discovery(found('web', '/w/web', true)), readiness: report.items, skips: [] });
    expect(byCode(items, 'services.declared').status).toBe('todo');
  });

  it('services.declared ignores a disabled repository', async () => {
    const m = manifestOf({ repositories: { web: repo({ enabled: false }) } });
    const items = await run(m, discovery(found('web', '/w/web', true)));
    expect(byCode(items, 'repos.registered').status).toBe('todo');
  });

  it('uat.paths is done when UAT is off', async () => {
    const items = await run({ ...FULL, uat: undefined } as Manifest, discovery(found('web', '/w/web', true)));
    const item = byCode(items, 'uat.paths');
    expect(item.status).toBe('done');
    expect(item.detail).toMatch(/UAT is off/);
  });

  it('uat.paths is todo when the tester command does not resolve', async () => {
    const m = { ...FULL, uat: { gates: [{ name: 'e2e', command: 'npm', args: ['run', '-s', 'gate:e2e'] }], repositories: {}, testerVerifier: { command: './missing.sh' } } } as unknown as Manifest;
    const items = await run(m, discovery(found('web', '/w/web', true)), { probes: { fileExists: () => false, binaryResolves: () => false } });
    expect(byCode(items, 'uat.paths').status).toBe('todo');
  });

  it('uat.paths is todo when a UAT gate script is missing', async () => {
    const items = await run(FULL, discovery(found('web', '/w/web', true)), { probes: { baseDefinesScript: async () => false } });
    expect(byCode(items, 'uat.paths').status).toBe('todo');
  });

  it('ticketing.provider, git.conventions and approaches.enabled are todo when unset', async () => {
    const m = { ...FULL, ticketing: undefined, conventions: {}, approaches: [{ id: 'a', label: 'A', enabled: false }] } as unknown as Manifest;
    const items = await run(m, discovery(found('web', '/w/web', true)));
    expect(byCode(items, 'ticketing.provider').status).toBe('todo');
    expect(byCode(items, 'git.conventions').status).toBe('todo');
    expect(byCode(items, 'approaches.enabled').status).toBe('todo');
  });
});

describe('computeChecklist: skips', () => {
  const skip = (code: string, target?: string): SkipRecord => ({ code, ...(target !== undefined ? { target } : {}), reason: 'user said so', at: '2026-01-01T00:00:00Z' });

  it('a skip without a target marks the todo item skipped', async () => {
    const items = await run(manifestOf(), discovery(), { skips: [skip('ticketing.provider')] });
    expect(byCode(items, 'ticketing.provider').status).toBe('skipped');
  });

  it('a skip with a target covers only that target', async () => {
    const d = discovery(found('web', '/w/web', true), found('docs', '/w/docs', false));
    const some = await run(manifestOf(), d, { skips: [skip('repos.registered', 'docs')] });
    expect(byCode(some, 'repos.registered').status).toBe('todo');
    expect(byCode(some, 'repos.registered').detail).not.toContain('docs');
    const all = await run(manifestOf(), d, { skips: [skip('repos.registered', 'docs'), skip('repos.registered', 'web')] });
    expect(byCode(all, 'repos.registered').status).toBe('skipped');
  });

  it('a skip of another code changes nothing', async () => {
    const items = await run(manifestOf(), discovery(), { skips: [skip('git.conventions')] });
    expect(byCode(items, 'ticketing.provider').status).toBe('todo');
  });

  it('a skip never hides a done item', async () => {
    const items = await run(FULL, discovery(found('web', '/w/web', true)), { skips: [skip('ticketing.provider')] });
    expect(byCode(items, 'ticketing.provider').status).toBe('done');
  });

  it('a whole-item skip covers every target of the item', async () => {
    const d = discovery(found('web', '/w/web', true), found('docs', '/w/docs', false));
    const items = await run(manifestOf(), d, { skips: [skip('repos.registered')] });
    expect(byCode(items, 'repos.registered').status).toBe('skipped');
  });
});
