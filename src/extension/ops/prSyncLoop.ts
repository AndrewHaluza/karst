export interface PrSyncOutcome {
  readonly changed: number;
  readonly mergeChanged: number;
  readonly landed: readonly unknown[];
  readonly archived: readonly unknown[];
  readonly worktreesSwept: boolean;
}

export interface PrSyncLoopDeps {
  readonly runOnce: (force: boolean) => Promise<PrSyncOutcome>;
  readonly onRefresh: () => void;
  readonly onError: (e: unknown) => void;
  readonly hasProject: () => boolean;
}

export function shouldRefresh(force: boolean, o: PrSyncOutcome): boolean {
  return force || o.changed > 0 || o.mergeChanged > 0 || o.landed.length > 0 || o.archived.length > 0 || o.worktreesSwept;
}

export function makePrSyncLoop(deps: PrSyncLoopDeps): (force?: boolean) => Promise<void> {
  let running = false;
  let forceQueued = false;

  const loop = async (force = false): Promise<void> => {
    if (!deps.hasProject()) return;
    if (running) {
      forceQueued ||= force;
      return;
    }
    running = true;
    try {
      const outcome = await deps.runOnce(force);
      if (shouldRefresh(force, outcome)) {
        deps.onRefresh();
      }
    } catch (e) {
      deps.onError(e);
    } finally {
      running = false;
      if (forceQueued) {
        forceQueued = false;
        void loop(true);
      }
    }
  };

  return loop;
}
