import { describe, it, expect } from 'vitest';
import { ManifestError } from './error.js';
import { validateGraphConfig } from './graphConfig.js';

/**
 * The nested `graph:` block validator. Every test here exercises the pure
 * validator through `validateGraphConfig`; load-level behavior (both-shapes
 * refusal, round-trip survival) lives in load.test.ts / writeManifest.test.ts.
 *
 * Invariants pinned here (invariant checklist A2–A4):
 * - every numeric limit is a finite safe integer inside its explicit range;
 * - fractions, negatives, NaN, and overflow are rejected, never coerced;
 * - product hard ceilings cannot be raised by project config;
 * - `maxExpertRuns < maxReplans + 1` is a named load-time error.
 */

/** A fully-populated graph block matching the design Configuration Model. */
function packagedGraphFixture(): Record<string, unknown> {
  return {
    planner: { profile: 'expert', prompt: { artifact: 'skills/graph-planner/SKILL.md' } },
    profiles: {
      expert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      worker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
      fast: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    },
    commands: {
      test: {
        command: 'npm',
        args: ['test'],
        cwd: 'repository',
        access: 'write',
        timeoutSeconds: 1800,
      },
      typecheck: {
        command: 'npm',
        args: ['run', 'typecheck'],
        cwd: 'repository',
        access: 'write',
        timeoutSeconds: 900,
      },
    },
    limits: {
      confirmGeneratedGraph: true,
      maxParallel: 1,
      maxNodeRuns: 40,
      maxExpertRuns: 5,
      maxReplans: 2,
      maxActivations: 200,
      maxGraphWallSeconds: 86400,
      maxAgentWallSeconds: 7200,
      maxAgentIdleSeconds: 1800,
      maxArtifactBytes: 104857600,
      maxLogBytes: 10485760,
      maxAggregateArtifactBytes: 536870912,
      maxAggregateWorkspaceBytes: 21474836480,
    },
  };
}

describe('validateGraphConfig', () => {
  it('defaults every absent field to the packaged defaults', () => {
    const cfg = validateGraphConfig({}, 'approaches[0].graph');
    expect(cfg.limits).toEqual({
      confirmGeneratedGraph: true,
      maxParallel: 4, // Slice-5 T7: the packaged concurrency default
      maxNodeRuns: 40,
      maxExpertRuns: 5,
      maxReplans: 2,
      maxActivations: 200,
      maxGraphWallSeconds: 86400,
      maxAgentWallSeconds: 7200,
      maxAgentIdleSeconds: 1800,
      maxArtifactBytes: 104857600,
      maxLogBytes: 10485760,
      maxAggregateArtifactBytes: 536870912,
      maxAggregateWorkspaceBytes: 21474836480,
    });
    expect(cfg.planner).toEqual({ profile: 'expert' });
    expect(cfg.profiles).toEqual({});
    expect(cfg.commands).toEqual({});
  });

  it('accepts a fully-populated block, preserving every field', () => {
    const raw = packagedGraphFixture();
    const cfg = validateGraphConfig(raw, 'approaches[0].graph');
    expect(cfg.limits).toEqual({
      confirmGeneratedGraph: true,
      maxParallel: 1,
      maxNodeRuns: 40,
      maxExpertRuns: 5,
      maxReplans: 2,
      maxActivations: 200,
      maxGraphWallSeconds: 86400,
      maxAgentWallSeconds: 7200,
      maxAgentIdleSeconds: 1800,
      maxArtifactBytes: 104857600,
      maxLogBytes: 10485760,
      maxAggregateArtifactBytes: 536870912,
      maxAggregateWorkspaceBytes: 21474836480,
    });
    expect(cfg.planner).toEqual({ profile: 'expert', prompt: { artifact: 'skills/graph-planner/SKILL.md' } });
    expect(cfg.profiles.expert).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'high' });
    expect(cfg.commands.test).toEqual({
      command: 'npm',
      args: ['test'],
      cwd: 'repository',
      access: 'write',
      timeoutSeconds: 1800,
    });
  });

  it('rejects unknown keys at every level, naming the field', () => {
    expect(() => validateGraphConfig({ nonsense: 1 }, 'g')).toThrow(/g has unknown key "nonsense"/);
    expect(() => validateGraphConfig({ planner: { nonsense: 1 } }, 'g')).toThrow(
      /g\.planner has unknown key "nonsense"/,
    );
    expect(() =>
      validateGraphConfig({ profiles: { expert: { nonsense: 1 } } }, 'g'),
    ).toThrow(/g\.profiles\.expert has unknown key "nonsense"/);
    expect(() =>
      validateGraphConfig({ commands: { test: { nonsense: 1 } } }, 'g'),
    ).toThrow(/g\.commands\.test has unknown key "nonsense"/);
    expect(() => validateGraphConfig({ limits: { nonsense: 1 } }, 'g')).toThrow(
      /g\.limits has unknown key "nonsense"/,
    );
  });

  describe('closed vocabularies', () => {
    it('cwd accepts repository | worktreeRoot only', () => {
      expect(
        validateGraphConfig({ commands: { t: { command: 'npm', args: [], cwd: 'worktreeRoot', access: 'read', timeoutSeconds: 60 } } }, 'g').commands.t!.cwd,
      ).toBe('worktreeRoot');
      expect(() =>
        validateGraphConfig({ commands: { t: { command: 'npm', args: [], cwd: '/etc', access: 'read', timeoutSeconds: 60 } } }, 'g'),
      ).toThrow(/cwd must be one of: repository, worktreeRoot/);
    });

    it('access accepts read | write only', () => {
      expect(() =>
        validateGraphConfig({ commands: { t: { command: 'npm', args: [], cwd: 'repository', access: 'rw', timeoutSeconds: 60 } } }, 'g'),
      ).toThrow(/access must be one of: read, write/);
    });

    it('provider accepts the closed agent-provider set only', () => {
      expect(() =>
        validateGraphConfig({ profiles: { w: { provider: 'copilot', model: 'x' } } }, 'g'),
      ).toThrow(/provider must be one of/);
    });

    it('env is a bounded NAME: value map of strings', () => {
      const cfg = validateGraphConfig(
        { commands: { t: { command: 'npm', args: [], cwd: 'repository', access: 'read', timeoutSeconds: 60, env: { NODE_ENV: 'test' } } } },
        'g',
      );
      expect(cfg.commands.t!.env).toEqual({ NODE_ENV: 'test' });

      // A non-string value is rejected.
      expect(() =>
        validateGraphConfig(
          { commands: { t: { command: 'npm', args: [], cwd: 'repository', access: 'read', timeoutSeconds: 60, env: { NODE_ENV: 1 } } } },
          'g',
        ),
      ).toThrow(/env\.NODE_ENV must be a string/);

      // An unsafe NAME (spaces, dashes, leading digit) is rejected.
      expect(() =>
        validateGraphConfig(
          { commands: { t: { command: 'npm', args: [], cwd: 'repository', access: 'read', timeoutSeconds: 60, env: { 'BAD NAME': 'x' } } } },
          'g',
        ),
      ).toThrow(/env key/);
    });
  });

  describe('numeric fields are finite safe integers in range', () => {
    it.each([
      'maxParallel',
      'maxNodeRuns',
      'maxExpertRuns',
      'maxReplans',
      'maxActivations',
      'maxGraphWallSeconds',
      'maxAgentWallSeconds',
      'maxAgentIdleSeconds',
      'maxArtifactBytes',
      'maxLogBytes',
      'maxAggregateArtifactBytes',
      'maxAggregateWorkspaceBytes',
    ] as const)('%s rejects 1.5, -1, NaN, MAX_SAFE+1, and a string', (field) => {
      for (const bad of [1.5, -1, NaN, Number.MAX_SAFE_INTEGER + 1, '5']) {
        expect(
          () => validateGraphConfig({ limits: { [field]: bad } }, 'g'),
          `${field} = ${String(bad)}`,
        ).toThrow(ManifestError);
      }
    });

    it('timeoutSeconds is a finite safe integer in 1..7200', () => {
      for (const bad of [0, 7201, 1.5, NaN, '30']) {
        expect(() =>
          validateGraphConfig(
            { commands: { t: { command: 'npm', args: [], cwd: 'repository', access: 'read', timeoutSeconds: bad } } },
            'g',
          ),
        ).toThrow(/timeoutSeconds/);
      }
      expect(
        validateGraphConfig(
          { commands: { t: { command: 'npm', args: [], cwd: 'repository', access: 'read', timeoutSeconds: 7200 } } },
          'g',
        ).commands.t!.timeoutSeconds,
      ).toBe(7200);
    });

    it('args is an array of strings', () => {
      expect(() =>
        validateGraphConfig(
          { commands: { t: { command: 'npm', args: [1], cwd: 'repository', access: 'read', timeoutSeconds: 60 } } },
          'g',
        ),
      ).toThrow(/args\[0\]/);
    });
  });

  describe('product hard ceilings (A3)', () => {
    it.each([
      ['maxParallel', 8],
      ['maxNodeRuns', 200],
      ['maxExpertRuns', 10],
      ['maxReplans', 5],
      ['maxActivations', 1000],
      ['maxGraphWallSeconds', 259200],
      ['maxAgentWallSeconds', 28800],
      ['maxAgentIdleSeconds', 7200],
      ['maxArtifactBytes', 104857600],
      ['maxLogBytes', 10485760],
      ['maxAggregateArtifactBytes', 1073741824],
      ['maxAggregateWorkspaceBytes', 107374182400],
    ] as const)('%s rejects ceiling+1 and accepts ceiling', (field, ceiling) => {
      expect(() => validateGraphConfig({ limits: { [field]: ceiling + 1 } }, 'g')).toThrow(
        new RegExp(`${field} must be an integer between 1 and ${ceiling}`),
      );
      // maxReplans at its ceiling needs maxExpertRuns >= maxReplans + 1 (A4),
      // which the packaged default of 5 cannot satisfy at maxReplans = 5.
      const limits =
        field === 'maxReplans'
          ? { [field]: ceiling, maxExpertRuns: 10 }
          : { [field]: ceiling };
      expect(validateGraphConfig({ limits }, 'g').limits[field]).toBe(ceiling);
    });
  });

  it('maxExpertRuns < maxReplans + 1 is a named manifest validation error (A4)', () => {
    expect(() => validateGraphConfig({ limits: { maxExpertRuns: 2, maxReplans: 2 } }, 'g')).toThrow(
      /maxExpertRuns must be at least maxReplans \+ 1/,
    );
    // The packaged defaults (5, 2) can never produce it.
    expect(() => validateGraphConfig({}, 'g')).not.toThrow();
  });
});
