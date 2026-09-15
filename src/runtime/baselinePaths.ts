import { join } from 'node:path';

/**
 * Where a baseline checkout lives, in ONE place.
 *
 * Two modules need this shape and for opposite reasons: `baseline.ts` creates
 * the checkout, and `portConflict.ts` recognises a baseline listener by the path
 * it runs from. If the layout ever moved and only the creator followed it, the
 * recogniser would silently stop matching — and a baseline would become killable
 * by the ordinary cwd rule, the exact regression the guard exists to prevent. A
 * leaf module (only `node:path`) keeps both derivations identical without a
 * cycle: neither `runtime/baseline.ts` nor `runtime/portConflict.ts` may import
 * the other (the port path is reached THROUGH the supervisor the baseline uses).
 */

/** The directory every baseline checkout lives under: `<repo>/.karst/baseline`. */
export function baselineRoot(repoPath: string): string {
  return join(repoPath, '.karst', 'baseline');
}

/** One service's baseline checkout: `<repo>/.karst/baseline/<service>`. */
export function baselineCheckoutDir(repoPath: string, service: string): string {
  return join(baselineRoot(repoPath), service);
}
