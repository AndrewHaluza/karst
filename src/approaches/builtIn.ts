/**
 * The packaged built-in approach definition: the one entry the graph runtime
 * ships in the VSIX, with the exact `graph:` block from the design's
 * Configuration Model. No fs at module load — `builtInPackageDir` resolves a
 * path; it never touches the disk.
 *
 * The built-in ships ENABLED (`enabled: true`, flipped by Slice 3 Task 12 —
 * the slice with a runtime behind it), not recommended, and with no
 * `commands` — the test/typecheck/build entries in the design's example are
 * PROJECT content, never packaged. Flipping earlier would have let a ticket
 * pick an approach whose impl launch had no runtime; the flip is the Slice-3
 * exit gate (Decision 31).
 */

import type { ApproachDef, GraphApproachConfig } from '../manifest/types.js';
import { DEFAULT_GRAPH_LIMITS } from '../manifest/graphConfig.js';
import { BUILT_IN_PACKAGE_ID } from './builtInId.js';

// Identity lives in the leaf `builtInId.ts` so a module that only needs to NAME
// the built-in never imports the module holding the packaged array.
export { BUILT_IN_PACKAGE_ID, BUILT_IN_PACKAGE_PATH, builtInPackageDir } from './builtInId.js';

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
  // The packaged limits ARE the validator's defaults — one shared table, so a
  // drifted default fails the packaged-equality test AND the validator test.
  limits: { ...DEFAULT_GRAPH_LIMITS },
};

/**
 * The complete set of packaged built-in approaches. Exactly one entry today;
 * the overlay seam (`withBuiltInApproaches`) consumes this array as-is.
 */
export const BUILT_IN_APPROACHES: readonly ApproachDef[] = [
  {
    id: BUILT_IN_PACKAGE_ID,
    label: 'Dynamic Graphs',
    recommended: false,
    enabled: true,
    graph: PACKAGED_GRAPH,
  },
];
