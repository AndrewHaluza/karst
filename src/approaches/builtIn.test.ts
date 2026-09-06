import { describe, expect, it } from 'vitest';
import { BUILT_IN_APPROACHES, builtInPackageDir, BUILT_IN_PACKAGE_ID } from './builtIn.js';

/**
 * The packaged built-in approach is the single source of truth for what the
 * graph runtime ships in the VSIX. These tests pin the definition to the
 * design's Configuration Model defaults field-for-field, so a drifted default
 * (a packaging edit, an accidental `recommended: true`) fails here rather than
 * silently changing what the picker and the runtime see.
 */

const packaged = BUILT_IN_APPROACHES[0]!;

describe('built-in approach package definition', () => {
  it('ships exactly one built-in: karst-graph-engineering', () => {
    expect(BUILT_IN_APPROACHES).toHaveLength(1);
    expect(BUILT_IN_APPROACHES[0]!.id).toBe('karst-graph-engineering');
    expect(BUILT_IN_APPROACHES[0]!.label).toBe('Dynamic Graph');
  });

  it('ships enabled (Slice 3 flip), not recommended, sourceless, and commandless', () => {
    expect(packaged.enabled).toBe(true);
    expect(packaged.recommended).toBe(false);
    expect(packaged.source).toBeUndefined();
    expect(packaged.graph?.commands).toEqual({});
  });

  it('packaged graph block matches the design Configuration Model exactly', () => {
    expect(packaged.graph).toBeDefined();
    const g = packaged.graph!;
    // Planner: expert profile with the packaged planner prompt artifact.
    expect(g.planner).toEqual({
      profile: 'expert',
      prompt: { artifact: 'skills/graph-planner/SKILL.md' },
    });
    // Profiles: expert = Opus high; worker/fast = Sonnet low (design table).
    expect(g.profiles).toEqual({
      expert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      worker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
      fast: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    });
  });

  it('packaged limits equal the design defaults exactly (table-driven)', () => {
    const expected = {
      confirmGeneratedGraph: true,
      // Slice-5 T7: parallelism ships at 4 (workspaces + leases + lineage).
      maxParallel: 4,
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
    };
    expect(packaged.graph!.limits).toEqual(expected);
  });

  it('packaged defaults can never violate maxExpertRuns >= maxReplans + 1', () => {
    expect(packaged.graph!.limits.maxExpertRuns).toBeGreaterThanOrEqual(
      packaged.graph!.limits.maxReplans + 1,
    );
  });
});

describe('built-in package path resolution', () => {
  it('resolves the packaged directory under a given extension root', () => {
    expect(builtInPackageDir('/ext')).toBe('/ext/.agents/skills/karst-graph-engineering');
  });

  it('exposes the package id used by consumers', () => {
    expect(BUILT_IN_PACKAGE_ID).toBe('karst-graph-engineering');
  });
});
