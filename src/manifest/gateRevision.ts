import { createHash } from 'node:crypto';
import type { Manifest } from './types.js';

/**
 * A stable fingerprint of the GATE-RELEVANT manifest, stamped on every stage run.
 *
 * Not a hash of the file: `karst.yml` changes for a hundred reasons that cannot
 * alter a gate set (a label template, a new repository nobody scoped), and a
 * fingerprint that moves for those would report "the gate set changed" on every
 * unrelated save — a warning that fires constantly is a warning nobody reads.
 * So exactly the three inputs `resolveGates` consults are hashed: the `uat` and
 * `review` blocks, and each repository's path (which decides what a probe finds).
 *
 * This answers RC5. A gate that FAILED and was then deleted from the manifest
 * reads, on the next attempt, as a stage that simply passed — the failing
 * question was removed rather than answered, and nothing recorded that. Two runs
 * with different hashes ran different question sets, and a reader can say so.
 *
 * Deterministic across processes: keys are sorted, so property order in the
 * loaded YAML can never change the digest. Truncated to 16 hex chars — this is
 * an equality marker between two runs of one ticket, not a security claim.
 */
export function gateRevision(manifest: Manifest | undefined): string | null {
  if (!manifest) return null;
  const repoPaths = Object.fromEntries(
    Object.entries(manifest.repositories ?? {}).map(([name, def]) => [name, def.repoPath]),
  );
  const shape = {
    uat: manifest.uat ?? null,
    review: manifest.review ?? null,
    repoPaths,
  };
  return createHash('sha256').update(stableStringify(shape)).digest('hex').slice(0, 16);
}

/** JSON with object keys sorted at every depth, so the digest is order-free. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
