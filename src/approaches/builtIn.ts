/**
 * The packaged built-in approach definition: the one entry the graph runtime
 * ships in the VSIX, with the exact `graph:` block from the design's
 * Configuration Model. No fs at module load — `builtInPackageDir` resolves a
 * path; it never touches the disk.
 *
 * The built-in ships DISABLED (`enabled: false`), not recommended, and with no
 * `commands` — the test/typecheck/build entries in the design's example are
 * PROJECT content, never packaged. The slice that flips `enabled` on is Slice 3
 * (Decision 31); until then no ticket may select an approach whose runtime does
 * not exist.
 */

import { join } from 'node:path';
import type { ApproachDef, GraphApproachConfig } from '../manifest/types.js';

export const BUILT_IN_PACKAGE_ID = 'karst-graph-engineering';

/** Relative path of the packaged prompt tree under the extension root. */
export const BUILT_IN_PACKAGE_PATH = `.agents/skills/${BUILT_IN_PACKAGE_ID}`;

/** Resolve the packaged package directory under an extension root. */
export function builtInPackageDir(extRoot: string): string {
  return join(extRoot, BUILT_IN_PACKAGE_PATH);
}

const PACKAGED_GRAPH: GraphApproachConfig = {
  planner: {
    profile: 'expert',
    prompt: { artifact: 'skills/graph-planner/SKILL.md' },
  },
  profiles: {
    expert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
    worker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    fast: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
  },
  commands: {},
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

/**
 * The complete set of packaged built-in approaches. Exactly one entry today;
 * the overlay seam (`withBuiltInApproaches`) consumes this array as-is.
 */
export const BUILT_IN_APPROACHES: readonly ApproachDef[] = [
  {
    id: BUILT_IN_PACKAGE_ID,
    label: 'Graph Engineering',
    recommended: false,
    enabled: false,
    graph: PACKAGED_GRAPH,
  },
];
