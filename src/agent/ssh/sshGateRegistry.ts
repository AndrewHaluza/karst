/**
 * The per-window SSH gate registry (D555, edit 6).
 *
 * Runners are rebuilt per call (`ticketSandboxRunner`, `sandboxRunnerFor`,
 * `resolveSsh`, D826's `sshRunnerFor`), so no runner holds the truth about
 * which remote gates are live. One ticket can run its UI lane and its main
 * lane at once, and service starts use `runGate` too. A per-window registry is
 * therefore the only place that can answer "may this sweep kill this pgid?" and
 * "which group ids does `stop` kill?".
 *
 * Keyed by `<remote>/<name>`: one remote sandbox, every runner instance. A sweep
 * never kills a run id that `live()` reports, so two concurrent gates — or two
 * windows' gates for the same ticket — cannot kill each other.
 */
export interface SshGateRegistry {
  /** Record a remote gate as live (called when `runGate` starts). */
  add(key: string, runId: string): void;
  /** Forget a gate (called when `runGate` settles, whatever the outcome). */
  remove(key: string, runId: string): void;
  /** A SNAPSHOT of the live run ids for one sandbox; empty for an unknown key. */
  live(key: string): ReadonlySet<string>;
}

/** The registry key of one remote sandbox: `<remote>/<name>`. */
export function sshGateKey(remote: string, name: string): string {
  return `${remote}/${name}`;
}

export function createSshGateRegistry(): SshGateRegistry {
  const byKey = new Map<string, Set<string>>();
  return {
    add(key, runId) {
      const ids = byKey.get(key);
      if (ids === undefined) byKey.set(key, new Set([runId]));
      else ids.add(runId);
    },
    remove(key, runId) {
      const ids = byKey.get(key);
      if (ids === undefined) return;
      ids.delete(runId);
      // Keep the map small; an empty set and a missing key are the same answer.
      if (ids.size === 0) byKey.delete(key);
    },
    live(key) {
      // A copy: a caller iterating it while another runner adds a gate must not
      // see a half-updated set, and cannot mutate the registry through it.
      return new Set(byKey.get(key) ?? []);
    },
  };
}

/** The window's registry: every ssh runner of this extension host shares it. */
export const WINDOW_SSH_GATE_REGISTRY: SshGateRegistry = createSshGateRegistry();
