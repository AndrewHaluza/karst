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
 * - a spent project replan cap comes FIRST: Replan is this category's only
 *   exit, and the cap refuses it before any repair could be followed. Naming a
 *   repair "then Replan" there looped the user through a refusal they could
 *   not see the reason for.
 * - `graph-workspace-deps` / `graph-preserve-failed` / a workspace byte
 *   ceiling each name the repair, then Replan, while project replans remain
 *   (Resume refuses the whole `config-then-resume` category).
 * - a spent document budget with project headroom says plainly that no config
 *   change is needed and counts the replans left; only a reached project cap
 *   below the hard ceiling names `limits.maxReplans`, and at the ceiling the
 *   advice is to stop.
 * - `explicit-resolution` is a shared refusal reason. The true
 *   `explicit-resolution` category (an integration conflict, a topology
 *   deadlock, an unrecognized reason) can never be resumed, but
 *   `retryReservedVisits` and `plannerRelaunchRecovery` also refuse with it
 *   while Resume is the offered action (an artifact that still fails its
 *   re-check, an unresolvable prompt re-snapshot, an unreadable bootstrap
 *   planner prompt). Name Resume for those, Replan only where Resume always
 *   refuses.
 *
 * `vscode`-free and store-free: a pure function of the refusal category, the
 * recovery category that refused, and the context the caller read.
 */

import type { RecoveryCategory, RecoveryRefusalReason } from './recovery.js';
import { GRAPH_HARD_CEILINGS } from '../../../manifest/graphConfig.js';
import { parseUsageLimitResetAt } from '../../../agent/cliFailure.js';

/** The first parameter: every refusal reason, plus the manual usage-limit stop. */
export type GuidanceCategory = RecoveryRefusalReason | 'usage-limit';

/** What the caller knows about the refusal besides its category: the run's
 *  recorded block reason, the recovery category that block mapped to, and —
 *  when read — the run's replan count against the project's
 *  `limits.maxReplans`. */
export interface RecoveryGuidanceContext {
  blockedReason: string | null;
  /** The recovery category the blocked run refused under. A resume-primary
   *  category (`launch-retry`, `prompt-resnapshot`, `artifact-recheck`,
   *  `planner-relaunch`) can refuse `explicit-resolution` while Resume is
   *  still the control the banner offers. */
  recoveryCategory?: RecoveryCategory;
  replanCount?: number;
  projectMaxReplans?: number;
  /** The clock a usage-limit reset is parsed against; defaults to now. */
  now?: Date;
}

/**
 * Whether Resume is still the offered action after an `explicit-resolution`
 * refusal. The true category refuses Resume unconditionally; the retry paths
 * return the same refusal reason when their re-check could not prove a
 * correction, and that correction is exactly what Resume exists to re-probe.
 */
function resumeRemainsTheExit(ctx: RecoveryGuidanceContext | undefined): boolean {
  if (ctx?.recoveryCategory !== undefined) {
    return ctx.recoveryCategory !== 'explicit-resolution';
  }
  // No category read: only the reasons whose refusal still offers Resume name
  // themselves. An unknown reason defaults to the true category (Replan only).
  const reason = ctx?.blockedReason ?? '';
  return (
    reason.startsWith('output-artifact-missing') ||
    reason.startsWith('artifact-unsafe') ||
    reason.startsWith('prompt-config-changed') ||
    reason.startsWith('planner-stale') ||
    // A usage-limit park is resumed on the run's current models.
    reason.startsWith('usage-limit')
  );
}

/** The park's graph-run reason: `usage-limit: <role> run <id> on <provider>/<model>: <text>`. */
// The model may itself contain a colon (`provider/model:variant`); it carries no
// whitespace, so the non-greedy group stops at the `: ` before the text.
const USAGE_LIMIT_REASON =
  /^usage-limit: (?:node|planner) run \d+ on ([^/\s]+)\/([^\s]+?): ([\s\S]*)$/;

/** A parsed ISO instant as the provider's local wall-clock form (`4:10am`). */
function resetClockText(iso: string): string {
  const at = new Date(iso);
  const hour24 = at.getHours();
  const suffix = hour24 >= 12 ? 'pm' : 'am';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(at.getMinutes()).padStart(2, '0')}${suffix}`;
}

/** The next step a user can actually take after a graph-recovery refusal. */
export function recoveryGuidance(
  category: GuidanceCategory,
  ctx?: RecoveryGuidanceContext,
): string {
  switch (category) {
    case 'config-then-resume': {
      const reason = ctx?.blockedReason;
      const replanCount = ctx?.replanCount;
      const projectMaxReplans = ctx?.projectMaxReplans;
      // A spent project cap FIRST: Replan is this category's only exit and the
      // cap refuses it outright (`replanRecovery` checks before the claim), so
      // no repair named below could be followed into a working Replan.
      if (
        replanCount !== undefined &&
        projectMaxReplans !== undefined &&
        replanCount >= projectMaxReplans
      ) {
        if (projectMaxReplans < GRAPH_HARD_CEILINGS.maxReplans) {
          return (
            'The replan limit is reached. Raise limits.maxReplans ' +
            `(up to ${GRAPH_HARD_CEILINGS.maxReplans}), then click Replan.`
          );
        }
        return 'The maximum is reached. Cancel the graph or switch the approach.';
      }
      // With replans left, the three reparable blocks each name their repair,
      // then Replan.
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
      // A spent document budget with project headroom: no config change needed.
      if (replanCount !== undefined && projectMaxReplans !== undefined) {
        const remaining = projectMaxReplans - replanCount;
        return (
          `Click Replan. ${remaining} of ${projectMaxReplans} replans remain. ` +
          'No config change is needed.'
        );
      }
      // No counts were read: a short truthful fallback that names no limit.
      return 'Click Replan to start a new revision, or adjust the graph limits in karst.yml.';
    }
    case 'explicit-resolution':
      // Never name a dead control, and never deny a live one.
      return resumeRemainsTheExit(ctx)
        ? 'Correct the artifact or prompt fault this block reports, then click Resume.'
        : 'Resume cannot clear this block. Click Replan to start a new graph revision.';
    case 'discard-required':
      return 'Discard the unknown process, then Resume.';
    case 'launch-loop':
      // No "Force a retry" here: `graphRefusalHandling` appends that only where
      // the modal offers the button.
      return (
        'The same node launched twice and exited before starting — the agent CLI ' +
        'is probably not trusting this folder; check its folder trust, then Replan.'
      );
    case 'usage-limit': {
      const reason = ctx?.blockedReason ?? '';
      const match = USAGE_LIMIT_REASON.exec(reason);
      const provider = match?.[1];
      const model = match?.[2];
      const text = match?.[3] ?? reason;
      const who = provider ? `${provider}/${model ?? 'default'}` : 'The agent';
      const resetIso = parseUsageLimitResetAt(text, ctx?.now ?? new Date());
      const reset = resetIso ? ` The limit resets at ${resetClockText(resetIso)}.` : '';
      return (
        `${who} hit its provider usage limit.${reset} ` +
        `Click Resume to retry on the run's current models, or use Pick agent/model… ` +
        'to switch this role first.'
      );
    }
  }
}
