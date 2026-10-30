import type { GateDef, Manifest } from '../../manifest/types.js';
import type { NamedGate } from '../../agent/promptText.js';
import { declaredGatesFor } from '../uat/gates.js';
import { declaredReviewGatesFor } from './gates.js';

/** The script (or command line) a declared gate runs, as the reviewer is told not to run it. */
function scriptOf(gate: GateDef): string | null {
  if (gate.kind === 'script') return gate.script ?? null;
  return gate.command ? [gate.command, ...(gate.args ?? [])].join(' ') : null;
}

/**
 * The enabled `review.gates` + `uat.gates` for one repository, de-duplicated by
 * name: what the gates phase already ran, so the findings reviewer need not.
 */
export function declaredCheckGates(manifest: Manifest | undefined, repo: string): NamedGate[] {
  // Hand-built manifests (tests, partial configs) may omit `repositories`.
  const review = manifest?.review?.repositories ? manifest.review : undefined;
  const uat = manifest?.uat?.repositories ? manifest.uat : undefined;
  const all = [...declaredReviewGatesFor(review, repo), ...declaredGatesFor(uat, repo)].filter((g) => g.enabled !== false);
  const seen = new Set<string>();
  const out: NamedGate[] = [];
  for (const g of all) {
    if (seen.has(g.name)) continue;
    seen.add(g.name);
    out.push({ name: g.name, script: scriptOf(g) });
  }
  return out;
}
