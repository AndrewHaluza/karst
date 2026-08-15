/**
 * The built-in approach's IDENTITY, split from its DEFINITION on purpose.
 *
 * `builtIn.ts` owns `BUILT_IN_APPROACHES` — the packaged array — and that array
 * may only ever be consumed through `withBuiltInApproaches` (the seam, pinned by
 * `withBuiltInApproaches.test.ts`). But naming the built-in is not resolving it:
 * the marker guard asks "is this ticket's approach the graph one?", which needs
 * the id and nothing else. Importing `builtIn.js` for that pulls a module whose
 * whole point is to stay behind the seam, so the id lives here, in a leaf with
 * no manifest imports, and `builtIn.ts` re-exports it for its own consumers.
 */

import { join } from 'node:path';

export const BUILT_IN_PACKAGE_ID = 'karst-graph-engineering';

/** Relative path of the packaged prompt tree under the extension root. */
export const BUILT_IN_PACKAGE_PATH = `.agents/skills/${BUILT_IN_PACKAGE_ID}`;

/** Resolve the packaged package directory under an extension root. */
export function builtInPackageDir(extRoot: string): string {
  return join(extRoot, BUILT_IN_PACKAGE_PATH);
}
