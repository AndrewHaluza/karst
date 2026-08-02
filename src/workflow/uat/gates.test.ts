import { describe, it, expect } from 'vitest';
import { declaredGatesFor, PROBE_SCRIPTS } from './gates.js';
import { uat } from '../../manifest/fixtures.js';

describe('PROBE_SCRIPTS', () => {
  it('orders cheapest first', () => {
    expect(PROBE_SCRIPTS).toEqual(['test', 'test:integration', 'e2e', 'test:e2e', 'cypress', 'playwright']);
  });
});

describe('declaredGatesFor', () => {
  it('returns nothing when no gates are configured', () => {
    expect(declaredGatesFor(undefined, null)).toEqual([]);
  });

  it('returns the global gates when no repo scoping applies', () => {
    const config = uat({ gates: [{ name: 'integration', kind: 'script', script: 'test:integration' }] });
    expect(declaredGatesFor(config, null)).toEqual([
      { name: 'integration', kind: 'script', script: 'test:integration' },
    ]);
  });

  it('keeps only the gates targeting this repository', () => {
    const config = uat({
      gates: [
        { name: 'test', kind: 'script', script: 'test' },
        { name: 'gotest', kind: 'command', command: 'go', args: ['test'], repo: 'api' },
      ],
    });
    expect(declaredGatesFor(config, 'web').map((g) => g.name)).toEqual(['test']);
    expect(declaredGatesFor(config, 'api').map((g) => g.name)).toEqual(['test', 'gotest']);
  });

  // Standing amendment: repository ENTRIES may share a repoPath (a monorepo
  // with several runnable services), and a repo may need a wholly different
  // gate list than the global one — `uat.repositories.<name>.gates` is that
  // override, and it must win over the global `uat.gates` list for its repo,
  // not merely add a `repo:`-scoped entry to it.
  it('lets a per-repository gate override replace the global gate list for that repo only', () => {
    const config = uat({
      gates: [{ name: 'test', kind: 'script', script: 'test' }],
      repositories: {
        api: { gates: [{ name: 'gotest', kind: 'command', command: 'go', args: ['test'] }] },
      },
    });
    expect(declaredGatesFor(config, 'api').map((g) => g.name)).toEqual(['gotest']);
    // The override is per-repo: an unrelated repo keeps the global list.
    expect(declaredGatesFor(config, 'web').map((g) => g.name)).toEqual(['test']);
  });
});
