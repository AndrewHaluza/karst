import { describe, it, expect } from 'vitest';
import { declaredReviewGatesFor, resolveReviewGates } from './gates.js';
import { review } from '../../manifest/fixtures.js';
import type { ScriptProbe } from '../gates/probe.js';

describe('declaredReviewGatesFor', () => {
  it('returns nothing when no gates are configured', () => {
    expect(declaredReviewGatesFor(undefined, null)).toEqual([]);
  });

  it('returns the global gates when no repo scoping applies', () => {
    const config = review({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] });
    expect(declaredReviewGatesFor(config, null)).toEqual([
      { name: 'lint', kind: 'script', script: 'lint' },
    ]);
  });

  it('keeps only the gates targeting this repository', () => {
    const config = review({
      gates: [
        { name: 'lint', kind: 'script', script: 'lint' },
        { name: 'govet', kind: 'command', command: 'go', args: ['vet', './...'], repo: 'api' },
      ],
    });
    expect(declaredReviewGatesFor(config, 'web').map((g) => g.name)).toEqual(['lint']);
    expect(declaredReviewGatesFor(config, 'api').map((g) => g.name)).toEqual(['lint', 'govet']);
  });

  // Standing amendment (mirrors uat/gates.test.ts): a per-repository gate
  // override REPLACES the global list for that repo only, it never adds to it.
  it('lets a per-repository gate override replace the global gate list for that repo only', () => {
    const config = review({
      gates: [{ name: 'lint', kind: 'script', script: 'lint' }],
      repositories: {
        api: { gates: [{ name: 'govet', kind: 'command', command: 'go', args: ['vet', './...'] }] },
      },
    });
    expect(declaredReviewGatesFor(config, 'api').map((g) => g.name)).toEqual(['govet']);
    expect(declaredReviewGatesFor(config, 'web').map((g) => g.name)).toEqual(['lint']);
  });
});

describe('resolveReviewGates', () => {
  const okProbe = (scripts: Record<string, string>): ScriptProbe => ({ kind: 'ok', scripts });

  it('falls back to probing REVIEW_PROBE_SCRIPTS when nothing is declared', () => {
    const resolution = resolveReviewGates(
      okProbe({ lint: 'eslint .', typecheck: 'tsc --noEmit' }),
      undefined,
      [],
    );
    expect(resolution).toMatchObject({
      kind: 'gates',
      gates: [
        { name: 'lint', command: 'npm', args: ['run', 'lint'], required: false },
        { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'], required: false },
      ],
    });
  });

  it('declared config wins over the probe outright', () => {
    const config = review({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] });
    const resolution = resolveReviewGates(okProbe({}), config, []);
    expect(resolution).toEqual({
      kind: 'gates',
      gates: [{ name: 'lint', command: 'npm', args: ['run', 'lint'], script: 'lint', required: true }],
      skipped: [],
    });
  });

  it("reports unavailable when the repository answers none of review's questions", () => {
    const miss = resolveReviewGates(okProbe({ deploy: 'foo' }), undefined, []);
    expect(miss).toMatchObject({ kind: 'unavailable', blocker: 'nothing-to-run' });
  });

  // Two manifest entries sharing a worktree (`dedupeTargetsByRepoPath`) union
  // their gates by invocation identity, not by name.
  it('unions the gates for every name backing one target, deduplicated by identity', () => {
    const config = review({
      repositories: {
        web: { gates: [{ name: 'lint', kind: 'script', script: 'lint' }] },
        admin: { gates: [{ name: 'lint', kind: 'script', script: 'lint' }] },
      },
    });
    const resolution = resolveReviewGates(okProbe({}), config, ['web', 'admin']);
    expect(resolution).toMatchObject({ kind: 'gates' });
    if (resolution.kind === 'gates') {
      expect(resolution.gates).toHaveLength(1);
    }
  });

  it('is unavailable only when every name produced nothing', () => {
    const config = review({
      repositories: {
        web: { gates: [{ name: 'lint', kind: 'script', script: 'lint' }] },
      },
    });
    // "admin" declares nothing and the probe answers none of review's default
    // questions either — but "web" still resolves to a gate, so the target as
    // a whole is answerable.
    const resolution = resolveReviewGates(okProbe({}), config, ['admin', 'web']);
    expect(resolution).toMatchObject({ kind: 'gates' });
    if (resolution.kind === 'gates') {
      expect(resolution.gates.map((g) => g.name)).toEqual(['lint']);
    }
  });

  it('drops a disabled gate from the resolved list and reports it as skipped', () => {
    const probe = okProbe({ lint: 'eslint .', typecheck: 'tsc' });
    const res = resolveReviewGates(probe, undefined, ['api'], ['lint']);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.gates.map((g) => g.name)).toEqual(['typecheck']);
    expect(res.skipped.map((g) => g.name)).toEqual(['lint']);
  });

  it('reports an empty skipped list when nothing is disabled', () => {
    const probe = okProbe({ lint: 'eslint .' });
    const res = resolveReviewGates(probe, undefined, ['api']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.skipped).toEqual([]);
  });

  it('resolves to zero gates, all skipped, when every gate is disabled', () => {
    const probe = okProbe({ lint: 'eslint .' });
    const res = resolveReviewGates(probe, undefined, ['api'], ['lint']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.gates).toEqual([]);
    expect(res.skipped.map((g) => g.name)).toEqual(['lint']);
  });

  it('leaves an unavailable resolution untouched — a disable cannot make an unreadable repo readable', () => {
    const ioProbe: ScriptProbe = { kind: 'io-error', message: 'EACCES' };
    const res = resolveReviewGates(ioProbe, undefined, ['api'], ['lint']);
    expect(res.kind).toBe('unavailable');
  });

  it('deduplicates skipped gates by name across repository entries sharing a worktree', () => {
    const probe = okProbe({ lint: 'eslint .' });
    const res = resolveReviewGates(probe, undefined, ['api', 'web'], ['lint']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.skipped.map((g) => g.name)).toEqual(['lint']);
  });
});
