import type { Manifest } from '../../manifest/types.js';
import type { RegenerateSpec } from './regenerate.js';

/** The gate-pass target: `repo` is the worktree's repoPath, `names` the manifest keys backed by it. */
export interface RegenerateTarget {
  readonly repo: string;
  readonly names: readonly string[];
}

/**
 * The `regenerate` run option for a target, or `{}` when it declares none (behavior unchanged).
 * `target.repo` is a repo PATH, not a manifest key: the manifest entry is found through
 * `target.names` (falling back to `repo` as a key). A skip is logged with its reason.
 */
export function regenerateOption(
  manifest: Manifest | undefined,
  target: RegenerateTarget,
  onDebug?: (message: string) => void,
): { regenerate?: RegenerateSpec } {
  const skip = (reason: string): { regenerate?: RegenerateSpec } => {
    onDebug?.(`[gate] regenerate (${target.names[0] ?? target.repo}): skipped — ${reason}`);
    return {};
  };
  if (!manifest) return skip('no manifest passed to the gate pass');
  const keys = target.names.length > 0 ? target.names : [target.repo];
  const hit = keys.find((k) => (manifest.repositories[k]?.ship?.regenerate?.length ?? 0) > 0);
  if (hit === undefined) {
    const known = keys.filter((k) => manifest.repositories[k] !== undefined);
    return skip(
      known.length === 0
        ? `no manifest repository matches ${keys.join(', ')}`
        : 'ship.regenerate is empty or undeclared',
    );
  }
  const ship = manifest.repositories[hit]!.ship!;
  return { regenerate: { repo: hit, commands: ship.regenerate!, exclude: ship.exclude ?? [] } };
}
