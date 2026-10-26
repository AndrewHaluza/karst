import { describe, expect, it } from 'vitest';
import { parseSetupCheckArgs, runSetupCheckCommand } from './setupCheck.js';
import { fakeProbes } from '../setup/readiness/fakeProbes.testutil.js';
import type { Manifest } from '../manifest/types.js';

const manifest = {
  host: '127.0.0.1',
  portRange: [3000, 3999],
  baselineBranch: 'main',
  repositories: { web: { repoPath: '/w/web', hasMigrations: false } },
} as unknown as Manifest;

describe('parseSetupCheckArgs', () => {
  it('no flags', () => expect(parseSetupCheckArgs(['setup', 'check'])).toEqual({ repos: [] }));
  it('splits and trims --repos', () =>
    expect(parseSetupCheckArgs(['setup', 'check', '--repos', 'web, api,'])).toEqual({ repos: ['web', 'api'] }));
  it('rejects a missing value', () =>
    expect(() => parseSetupCheckArgs(['setup', 'check', '--repos'])).toThrow('--repos needs a value'));
  it('rejects unknown flags', () =>
    expect(() => parseSetupCheckArgs(['setup', 'check', '--x'])).toThrow("unknown argument '--x'"));
  it('rejects the wrong verb', () =>
    expect(() => parseSetupCheckArgs(['setup', 'verify'])).toThrow("expected 'setup check', got 'setup verify'"));
});

describe('runSetupCheckCommand', () => {
  it('ok json when green', async () => {
    const out = JSON.parse(await runSetupCheckCommand({ manifest, warnings: [], repos: [], probes: fakeProbes() }));
    expect(out.ok).toBe(true);
    expect(out.items.length).toBeGreaterThan(0);
  });
  it('not ok when a probe fails', async () => {
    const out = JSON.parse(
      await runSetupCheckCommand({ manifest, warnings: [], repos: [], probes: fakeProbes({ isGitRepo: () => false }) }),
    );
    expect(out.ok).toBe(false);
  });
});
