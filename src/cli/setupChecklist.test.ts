import { describe, it, expect } from 'vitest';
import { runSetupChecklistCommand, parseSetupChecklistArgs } from './setupChecklist.js';
import { fakeProbes } from '../setup/readiness/fakeProbes.testutil.js';
import type { Manifest } from '../manifest/types.js';
import type { DiscoveryResult } from '../setup/discover.js';

const manifest = {
  host: '127.0.0.1', portRange: [3000, 3999], baselineBranch: 'main', agentProvider: 'claude', defaultModel: 'm',
  repositories: { web: { repoPath: '/w/web', hasMigrations: false } },
} as unknown as Manifest;
const discovery: DiscoveryResult = {
  empty: false,
  repos: [{ name: 'web', path: '/w/web', baselineBranch: 'main', baselineBranchSource: 'origin-head', service: null, serviceReason: 'none' }],
};
const base = { manifest, warnings: [], repos: [], probes: fakeProbes(), discovery, skips: [], manifestDir: '/w' };

describe('setup checklist command', () => {
  it('prints the items, the counts and the next todo', async () => {
    const out = JSON.parse(await runSetupChecklistCommand(base));
    expect(out.items.map((i: { code: string }) => i.code)[0]).toBe('repos.registered');
    expect(out.summary).toMatchObject({ requiredTodo: 1 });
    expect(out.ok).toBe(false);
    expect(out.next).toBe('quality.gates');
  });

  it('is ok when no required item is todo', async () => {
    const m = { ...manifest, review: { gates: [{ name: 'l', command: 'npm', args: ['run', '-s', 'gate:l'] }], repositories: {} } } as unknown as Manifest;
    const out = JSON.parse(await runSetupChecklistCommand({ ...base, manifest: m }));
    expect(out.ok).toBe(true);
    expect(out.summary.requiredTodo).toBe(0);
  });

  it('a skip lowers the required todo count', async () => {
    const out = JSON.parse(
      await runSetupChecklistCommand({ ...base, skips: [{ code: 'quality.gates', reason: 'none', at: 't' }] }),
    );
    expect(out.ok).toBe(true);
    expect(out.items.find((i: { code: string }) => i.code === 'quality.gates').status).toBe('skipped');
  });

  it('shows every item todo for a manifest that does not load', async () => {
    const out = JSON.parse(await runSetupChecklistCommand({ ...base, manifest: undefined, loadError: 'ENOENT' }));
    expect(new Set(out.items.map((i: { status: string }) => i.status))).toEqual(new Set(['todo']));
    expect(out.ok).toBe(false);
  });
});

describe('parseSetupChecklistArgs', () => {
  it('takes no flag', () => {
    expect(() => parseSetupChecklistArgs(['setup', 'checklist'])).not.toThrow();
    expect(() => parseSetupChecklistArgs(['setup', 'checklist', '--skip', 'x'])).toThrow(/unknown argument '--skip'/);
    expect(() => parseSetupChecklistArgs(['setup', 'status'])).toThrow(/expected 'setup checklist'/);
  });
});
