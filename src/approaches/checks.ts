import { CHAIN_EDGES, type ApproachDef, type ChainEdge } from '../manifest/types.js';

export { CHAIN_EDGES, type ChainEdge };

/**
 * Edges known approaches verify themselves, so karst does not check them again
 * (speckit `/analyze` cross-checks spec ↔ plan; superpowers writing-plans
 * self-reviews the plan against the spec).
 */
export const BUILT_IN_CHECKS: Readonly<Record<string, readonly ChainEdge[]>> = {
  speckit: ['spec-plan'],
  superpowers: ['spec-plan'],
};

export function effectiveChecks(approach: Pick<ApproachDef, 'id' | 'checks'>): ReadonlySet<ChainEdge> {
  if (approach.checks !== undefined) return new Set(approach.checks);
  return new Set(BUILT_IN_CHECKS[approach.id] ?? []);
}
