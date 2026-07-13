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
  services: Record<string, ResolvedService>;
  /** [H2] hot services in topological (dependency-first) order for startup */
  startOrder: string[];
}
