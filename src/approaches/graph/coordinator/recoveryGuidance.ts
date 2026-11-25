/**
 * The ONE source of graph-recovery guidance text (T1359, D793).
 *
 * A refusal reaches the user through two surfaces: the `recoverGraphRun`
 * diagnostic (debug sink only) and the notice the Resume/Replan controls show
 * (`graphRecoveryRefusalNotice`, always visible). Keeping the advice in one
 * function means the two cannot drift, and a pin test in `recovery.test.ts`
 * and `graphRecovery.test.ts` holds each surface to this text.
 *
 * Every sentence here must be FOLLOWABLE from the state it names:
 * - `graph-workspace-deps` / `graph-preserve-failed` / a workspace byte
 *   ceiling each name the repair, then Replan (Resume refuses the whole
 *   `config-then-resume` category unconditionally).
 * - a spent document budget with project headroom says plainly that no config
 *   change is needed and counts the replans left; only a reached project cap
 *   below the hard ceiling names `limits.maxReplans`, and at the ceiling the
 *   advice is to stop.
 * - `explicit-resolution` never promises a Resume — Resume refuses every
 *   reason in that category (`integration-conflict`, `graph-topology-deadlock`,
 *   a null reason, an unknown one), so Replan is the only exit.
 *
 * `vscode`-free and store-free: a pure function of the refusal category and
 * the context the caller read.
 */

import type { RecoveryRefusalReason } from './recovery.js';
import { GRAPH_HARD_CEILINGS } from '../../../manifest/graphConfig.js';

/** What the caller knows about the refusal besides its category: the run's
 *  recorded block reason and — when read — the run's replan count against the
 *  project's `limits.maxReplans`. */
export interface RecoveryGuidanceContext {
  blockedReason: string | null;
  replanCount?: number;
  projectMaxReplans?: number;
}

/** The next step a user can actually take after a graph-recovery refusal. */
export function recoveryGuidance(
  category: RecoveryRefusalReason,
  ctx?: RecoveryGuidanceContext,
): string {
  switch (category) {
    case 'config-then-resume': {
      const reason = ctx?.blockedReason;
      // The three reparable blocks first: each names its repair, then Replan.
      if (reason?.startsWith('graph-workspace-deps')) {
        return (
          'Install the dependencies in the ticket worktree or set ' +
          'repositories.<name>.graphWorkspace in karst.yml. Then click Replan.'
        );
      }
      if (reason?.startsWith('graph-preserve-failed')) {
        return (
          'The node workspace holds work that could not be written to a patch; ' +
          'repair the cause, then click Replan.'
        );
      }
      if (reason?.startsWith('graph-budget-exhausted') && reason.includes('workspace ceiling')) {
        return (
          'Raise limits.maxAggregateWorkspaceBytes in karst.yml or free workspace space. ' +
          'Then click Replan.'
        );
      }
      // A spent budget: only name a config change while one is still possible.
      if (ctx?.replanCount !== undefined && ctx.projectMaxReplans !== undefined) {
        if (ctx.replanCount < ctx.projectMaxReplans) {
          const remaining = ctx.projectMaxReplans - ctx.replanCount;
          return (
            `Click Replan. ${remaining} of ${ctx.projectMaxReplans} replans remain. ` +
            'No config change is needed.'
          );
        }
        if (ctx.projectMaxReplans < GRAPH_HARD_CEILINGS.maxReplans) {
          return (
            'The replan limit is reached. Raise limits.maxReplans ' +
            `(up to ${GRAPH_HARD_CEILINGS.maxReplans}), then click Replan.`
          );
        }
        return 'The maximum is reached. Cancel the graph or switch the approach.';
      }
      // No counts were read: a short truthful fallback that names no limit.
      return 'Click Replan to start a new revision, or adjust the graph limits in karst.yml.';
    }
    case 'explicit-resolution':
      // Resume refuses EVERY reason in this category — never promise one.
      return 'Resume cannot clear this block. Click Replan to start a new graph revision.';
    case 'discard-required':
      return 'Discard the unknown process, then Resume.';
    case 'launch-loop':
      // No "Force a retry" here: `graphRefusalHandling` appends that only where
      // the modal offers the button.
      return (
        'The same node launched twice and exited before starting — the agent CLI ' +
        'is probably not trusting this folder; check its folder trust, then Replan.'
      );
  }
}
