/** Output of the resolver (§7.2) — per-service runtime config for a ticket. */

export type ServiceMode = 'hot' | 'baseline';

export interface ResolvedService {
  mode: ServiceMode;
  /** own-port slot name → allocated (hot) or default (baseline) value */
  ports: Record<string, number>;
  /** resolved env: own-port vars + peer-reference vars from dependsOn edges */
  env: Record<string, string>;
  /** baseline services this hot service references (drives baseline_refs) */
  baselineDeps: string[];
}

export interface ResolveResult {
  /**
   * Runtime config per RUNNABLE repository. A repository declaring no service
   * has no entry — ports and env are meaningless without a process, so a fake
   * empty entry would just be a sentinel by another name. Use `nonRunnable` to
   * tell "not runnable" apart from "not in the manifest".
   */
  services: Record<string, ResolvedService>;
  /**
   * Repositories in the manifest that declare no service. Reported explicitly so
   * consumers can SAY so (previewEnv, the dashboard) rather than inferring it
   * from an absence, which would read identically to a missing entry.
   */
  nonRunnable: string[];
  /** [H2] hot runnable repos in topological (dependency-first) order for startup */
  startOrder: string[];
}
