import { describe, it, expect } from 'vitest';
import { expandEnvTokens, allocationRanges, hotRepoPaths, mergeRanges } from './spin.js';
import { manifest, repo, runnableRepo } from '../manifest/fixtures.js';

describe('expandEnvTokens', () => {
  const env = { PORT: '4001', HOST: '127.0.0.1' };

  it('expands ${VAR} braced tokens', () => {
    expect(expandEnvTokens('npm run dev -- --port ${PORT} --strictPort', env)).toBe(
      'npm run dev -- --port 4001 --strictPort',
    );
  });

  it('expands $VAR bare tokens', () => {
    expect(expandEnvTokens('serve --host $HOST --port $PORT', env)).toBe(
      'serve --host 127.0.0.1 --port 4001',
    );
  });

  it('leaves a token-free command untouched', () => {
    expect(expandEnvTokens('npm run dev', env)).toBe('npm run dev');
  });

  it('expands an unknown token to empty string (shell-like)', () => {
    expect(expandEnvTokens('run --x ${MISSING}', env)).toBe('run --x ');
  });
});

describe('allocationRanges', () => {
  it('is the manifest range when no service overrides it', () => {
    const m = manifest({ api: runnableRepo() }, { portRange: [4000, 4999] });
    expect(allocationRanges(m, ['api'])).toEqual([[4000, 4999]]);
  });

  it('adds each service override', () => {
    const m = manifest(
      {
        api: runnableRepo({ portRange: [5000, 5100] }),
        web: runnableRepo({ portRange: [6000, 6100] }),
      },
      { portRange: [4000, 4999] },
    );
    // [4000,4999] and [5000,5100] touch, so they describe one contiguous span
    // and are walked as one; [6000,6100] is genuinely separate.
    expect(allocationRanges(m, ['api', 'web'])).toEqual([
      [4000, 5100],
      [6000, 6100],
    ]);
  });

  it('names an identical window once, however many services share it', () => {
    // Two services of a monorepo repeating one override, plus an override that
    // simply restates the manifest range: probing the same window twice costs
    // the sweep's budget and logs the same ports twice.
    const m = manifest(
      {
        api: runnableRepo({ portRange: [5000, 5100] }),
        grpc: runnableRepo({ portRange: [5000, 5100] }),
        web: runnableRepo({ portRange: [4000, 4999] }),
      },
      { portRange: [4000, 4999] },
    );
    expect(allocationRanges(m, ['api', 'grpc', 'web'])).toEqual([[4000, 5100]]);
  });

  it('merges an override that overlaps the manifest range', () => {
    // The window is walked once, not once per description of it.
    const m = manifest(
      { api: runnableRepo({ portRange: [4500, 5100] }) },
      { portRange: [4000, 4999] },
    );
    expect(allocationRanges(m, ['api'])).toEqual([[4000, 5100]]);
  });

  it('merges an override contained entirely inside the manifest range', () => {
    const m = manifest(
      { api: runnableRepo({ portRange: [4100, 4200] }) },
      { portRange: [4000, 4999] },
    );
    expect(allocationRanges(m, ['api'])).toEqual([[4000, 4999]]);
  });

  it('ignores a repository that declares no service', () => {
    const m = manifest({ docs: repo() }, { portRange: [4000, 4999] });
    expect(allocationRanges(m, ['docs'])).toEqual([[4000, 4999]]);
  });
});

describe('hotRepoPaths', () => {
  it('dedups entries that share one checkout', () => {
    const m = manifest({
      api: runnableRepo({}, { repoPath: '/mono' }),
      web: runnableRepo({}, { repoPath: '/mono' }),
      docs: repo({ repoPath: '/docs' }),
    });
    expect(hotRepoPaths(m, ['api', 'web', 'docs'])).toEqual(['/mono', '/docs']);
  });

  it('skips a name the manifest does not declare', () => {
    const m = manifest({ api: runnableRepo({}, { repoPath: '/api' }) });
    expect(hotRepoPaths(m, ['api', 'ghost'])).toEqual(['/api']);
  });
});

describe('mergeRanges', () => {
  it('leaves disjoint windows alone, in ascending order', () => {
    expect(mergeRanges([[6000, 6100], [4000, 4999]])).toEqual([
      [4000, 4999],
      [6000, 6100],
    ]);
  });

  it('collapses identical windows to one', () => {
    expect(mergeRanges([[5000, 5100], [5000, 5100]])).toEqual([[5000, 5100]]);
  });

  it('merges overlapping windows into their union', () => {
    expect(mergeRanges([[4000, 4999], [4500, 5100]])).toEqual([[4000, 5100]]);
  });

  it('merges windows that merely touch', () => {
    expect(mergeRanges([[4000, 4099], [4100, 4199]])).toEqual([[4000, 4199]]);
  });

  it('keeps a window swallowed by a wider one out of the result', () => {
    expect(mergeRanges([[4000, 4999], [4100, 4200]])).toEqual([[4000, 4999]]);
  });

  it('passes an inverted range through rather than repairing a bad manifest', () => {
    // `portsIn` yields nothing for it; quietly flipping it would hide the typo.
    expect(mergeRanges([[4000, 4999], [5100, 5000]])).toEqual([
      [4000, 4999],
      [5100, 5000],
    ]);
  });

  it('is empty for no ranges', () => {
    expect(mergeRanges([])).toEqual([]);
  });
});
