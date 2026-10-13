import type { StageKey } from '../types.js';
import type { InsideStageKey, ProcessEvidenceView } from './types.js';

/**
 * The six-stage inside contract's process roster: which processes each inside
 * stage presents, in presentation order. Pure presentation data — the runtime
 * stage machine (`StageKey`, the graph) is untouched, and `fix` appears here
 * nowhere because it is projected onto the stage it returns to
 * (`insideStageForRuntimeStage`).
 *
 * `gates` legitimately appears in both uat and review: both stages resolve and
 * run the same per-repository gates, so a process listed twice is one process
 * observed from two stages, never a collision. `services` is UAT's alone (D155):
 * only UAT starts the ticket's services (before the Tester) and stops them
 * after, so only UAT presents a Services row.
 */
export const INSIDE_PROCESSES: Readonly<Record<InsideStageKey, readonly string[]>> = {
  scope: ['hot-set', 'worktrees'],
  impl: ['session'],
  uat: ['gates', 'services', 'tester'],
  // Review does not spin or stop services (D155) — its lint/build gates need no
  // running app — so it presents no Services row.
  review: ['gates', 'review'],
  ship: ['commit', 'push', 'pr', 'merge'],
  done: ['delivery-receipt'],
};

/**
 * Map the runtime stage onto the six-stage presentation model. `fix` is not a
 * stage a person visits — it is recovery attached to the stage it returns to —
 * so it projects onto `fixFallback`, the stage the fix is causally attached
 * to. Every other runtime key names the same stage in both models.
 */
export function insideStageForRuntimeStage(
  stageKey: StageKey,
  fixFallback: 'uat' | 'review',
): InsideStageKey {
  return stageKey === 'fix' ? fixFallback : stageKey;
}

/**
 * The evidence renderer each process id is entitled to. Unknown ids — a
 * process a newer build introduced than the reducer knows — fall back to the
 * generic `rows` renderer rather than failing or inventing a shape.
 */
const PROCESS_EVIDENCE_KIND: Readonly<Record<string, ProcessEvidenceView['kind']>> = {
  'hot-set': 'rows',
  worktrees: 'rows',
  session: 'timeline',
  gates: 'gates',
  services: 'rows',
  tester: 'rows',
  review: 'findings',
  commit: 'commits',
  push: 'rows',
  pr: 'prs',
  merge: 'rows',
  'delivery-receipt': 'receipt',
};

/** The evidence kind a process's reducer must emit. Unknown ids → `rows`. */
export function evidenceKindForProcess(id: string): ProcessEvidenceView['kind'] {
  return PROCESS_EVIDENCE_KIND[id] ?? 'rows';
}
