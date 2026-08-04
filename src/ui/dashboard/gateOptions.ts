import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { getDisabledGates } from '../../store/ticketGates.js';
import { probeScripts, type ScriptProbe } from '../../workflow/gates/probe.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { planUatTargets } from '../../workflow/uat/targets.js';
import { planReviewTargets } from '../../workflow/review/targets.js';
import { resolveTargetGates } from '../../workflow/stages/uat.js';
import { resolveReviewGates } from '../../workflow/review/gates.js';

/**
 * One gate a ticket's stage would run, and whether the user has switched it off.
 *
 * The RESOLVED name, never the raw manifest list: repository-scoped overrides
 * and package.json auto-discovery both change what actually runs, and offering
 * a toggle for a gate that would never run (or omitting one that would) is a
 * control that lies.
 */
export interface GateOption {
  name: string;
  disabled: boolean;
}

export interface GateOptions {
  uat: GateOption[];
  review: GateOption[];
}

export type GateOptionsLoader = (ticketId: number, signal: AbortSignal) => Promise<GateOptions>;

/** Names in resolution order, deduplicated — one toggle per name, not per repo. */
function optionsFrom(names: readonly string[], disabled: readonly string[]): GateOption[] {
  const seen = new Set<string>();
  const out: GateOption[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, disabled: disabled.includes(name) });
  }
  // A gate the user disabled is REMOVED from the resolved list by construction,
  // so it would otherwise vanish from the very panel that has to offer the way
  // back. Appended here so a disabled gate is always re-enableable.
  for (const name of disabled) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, disabled: true });
  }
  return out;
}

/**
 * Resolve the gate names a ticket's uat/review stages would run right now.
 *
 * Async and filesystem-touching (it probes each worktree's package.json), which
 * is why it is NOT part of `buildDashboardState`: that builder is synchronous
 * and store-only by design, and the panel already has a precedent for a
 * supplemental async push in `pushWorktreeStats`. Every failure degrades to
 * empty lists — a panel that cannot resolve gates shows no toggles, which is
 * strictly better than offering one that would not match what runs.
 *
 * Deliberately calls `resolveTargetGates`/`resolveReviewGates` WITHOUT
 * `disabledNames`, so the resolved list is what the stage would run *if
 * nothing were disabled* — the full set of togglable names. The `disabled`
 * flag itself comes straight from the store (`getDisabledGates`).
 */
export function buildGateOptionsLoader(deps: {
  store: Store;
  manifest: () => Manifest | undefined;
  probe?: (cwd: string) => ScriptProbe;
  git?: GitRunner;
}): GateOptionsLoader {
  const probe = deps.probe ?? probeScripts;
  const git = deps.git ?? defaultGitRunner;

  return async (ticketId, signal): Promise<GateOptions> => {
    const empty: GateOptions = { uat: [], review: [] };
    const manifest = deps.manifest();
    if (!manifest) return empty;
    const disabled = getDisabledGates(deps.store, ticketId);
    try {
      const worktrees = listWorktreesByTicket(deps.store, ticketId);
      const [uatPlan, reviewPlan] = await Promise.all([
        planUatTargets(manifest, worktrees, git),
        planReviewTargets(manifest, worktrees, git),
      ]);
      if (signal.aborted) return empty;

      const uatNames: string[] = [];
      if (uatPlan.kind === 'targets') {
        for (const target of uatPlan.targets) {
          const resolution = resolveTargetGates(probe(target.path), manifest.uat, target.names);
          if (resolution.kind !== 'gates') continue;
          uatNames.push(...resolution.gates.map((g) => g.name));
        }
      }

      const reviewNames: string[] = [];
      if (reviewPlan.kind === 'targets') {
        for (const target of reviewPlan.targets) {
          const resolution = resolveReviewGates(probe(target.path), manifest.review, target.names);
          if (resolution.kind !== 'gates') continue;
          reviewNames.push(...resolution.gates.map((g) => g.name));
        }
      }

      return {
        uat: optionsFrom(uatNames, disabled.uat),
        review: optionsFrom(reviewNames, disabled.review),
      };
    } catch {
      // A broken git, an unreadable tree — the panel is an observer here and a
      // failed observation must never surface as a failed ticket.
      return empty;
    }
  };
}
