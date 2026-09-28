import type { GateStage } from '../../store/ticketGates.js';
import type { DashboardState } from './state.js';

/**
 * Panel-only dashboard memory, held host-side like every other panel read.
 *
 * Two selections live here: the round switcher's current selection per ticket
 * (Option B, T5) and the findings repo scope selection per ticket per gate
 * stage. Both are pure reads — they never touch the store, never mutate the
 * ticket, and re-render through the normal state push. Both die with the panel
 * (cleared on dispose) so a selection never leaks to a later ticket that
 * happens to reuse the id.
 */
export class DashboardSelections {
  private readonly attempts = new Map<number, ReadonlyMap<GateStage, string>>();
  private readonly findingsRepos = new Map<number, ReadonlyMap<GateStage, string | null>>();

  /**
   * Record the round switcher's selection for a ticket. A ticket with no
   * selection is absent from the map entirely, which is what keeps
   * `buildDashboardState`'s `attemptSelection` argument (and therefore its
   * output) unchanged for every ticket that never touched a tab.
   */
  selectAttempt(ticketId: number, stage: GateStage, key: string): void {
    const current = this.attempts.get(ticketId) ?? new Map<GateStage, string>();
    const next = new Map(current);
    next.set(stage, key);
    this.attempts.set(ticketId, next);
  }

  /**
   * Record the findings repo scope selection for a ticket per stage. A `null`
   * repo DELETES the stage's entry rather than storing a sentinel; a stage
   * absent from the map means "all repositories".
   */
  selectFindingsRepo(ticketId: number, stage: GateStage, repo: string | null): void {
    const current = this.findingsRepos.get(ticketId) ?? new Map<GateStage, string | null>();
    const next = new Map(current);
    if (repo === null) next.delete(stage);
    else next.set(stage, repo);
    if (next.size === 0) this.findingsRepos.delete(ticketId);
    else this.findingsRepos.set(ticketId, next);
  }

  /** This ticket's round switcher selection, plain-object shaped for `buildDashboardState`. */
  attemptSelectionFor(ticketId: number): Partial<Record<'uat' | 'review', string>> {
    return Object.fromEntries(this.attempts.get(ticketId) ?? []);
  }

  /** This ticket's findings repo selection, plain-object shaped for `buildDashboardState`. */
  findingsRepoSelectionFor(ticketId: number): Partial<Record<'uat' | 'review', string>> | undefined {
    const map = this.findingsRepos.get(ticketId);
    if (!map || map.size === 0) return undefined;
    return Object.fromEntries(map);
  }

  /**
   * Drop any selection the snapshot just rendered did NOT resolve to — the
   * state builder falls back to latest for a key naming no recorded attempt
   * (a stale panel selection, or a ticket that has since re-run the stage),
   * and a selection that has already stopped meaning anything should not
   * keep being requested on every following push.
   */
  pruneStaleAttempts(ticketId: number, state: DashboardState): void {
    const current = this.attempts.get(ticketId);
    if (!current || current.size === 0) return;
    let changed = false;
    const next = new Map(current);
    for (const stage of ['uat', 'review'] as const) {
      const requested = current.get(stage);
      if (requested === undefined) continue;
      if (state.insideViews[stage]?.selectedAttempt !== requested) {
        next.delete(stage);
        changed = true;
      }
    }
    if (!changed) return;
    if (next.size === 0) this.attempts.delete(ticketId);
    else this.attempts.set(ticketId, next);
  }

  /**
   * Drop any findings repo selection the snapshot just rendered did NOT resolve
   * to — when the batch names fewer than two repos, the reducer emits no
   * `repoFilter`, and a selection that no longer applies should not keep being
   * requested on every following push.
   */
  pruneStaleFindingsRepos(ticketId: number, state: DashboardState): void {
    const current = this.findingsRepos.get(ticketId);
    if (!current || current.size === 0) return;
    let changed = false;
    const next = new Map(current);
    for (const stage of ['uat', 'review'] as const) {
      const requested = current.get(stage);
      if (requested === undefined) continue;
      const view = state.insideViews[stage];
      const processes = view?.processes ?? [];
      const filter = processes.find((p) => p.id === (stage === 'uat' ? 'tester' : 'review'))?.repoFilter;
      // The selection is valid when the filter exists and names the selected
      // repo, OR when the filter is absent because there are fewer than two
      // repos (the selection degrades to "all" silently).
      if (filter && requested !== null && !filter.repos.includes(requested)) {
        next.delete(stage);
        changed = true;
      } else if (!filter && requested !== undefined) {
        next.delete(stage);
        changed = true;
      }
    }
    if (!changed) return;
    if (next.size === 0) this.findingsRepos.delete(ticketId);
    else this.findingsRepos.set(ticketId, next);
  }

  /** The panel's selections die with it — a later open starts at the defaults. */
  clear(ticketId: number): void {
    this.attempts.delete(ticketId);
    this.findingsRepos.delete(ticketId);
  }
}
