import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The UAT/review setup runbook that ships WITH the extension and is written
 * into a target project, never kept as a doc in karst's own tree.
 *
 * It exists for the agent configuring some OTHER project right after karst is
 * installed there, so it has to travel to that project: as one of karst's own
 * `docs/` files it would only ever be read by people working on karst, while
 * costing every one of them context. Same delivery as `karst.example.yml` —
 * a repo-root asset, copied to `dist/` by `scripts/copy-assets.mjs`, written
 * out at scaffold time.
 *
 * It lands beside the scaffolded `karst.yml` (default `.karst/`), which is the
 * one directory the reader is already in when they are configuring the
 * manifest — and which `ensureKarstExcluded` keeps out of the target
 * repository's git, so it costs that project no committed space either.
 *
 * Kept vscode-free so it is testable: the activation layer
 * (`extension/manifestResolve.ts`) supplies the bundled bytes and the path.
 */

/** Basename of the runbook — identical at the repo root, in `dist/`, and in the target project. */
export const SETUP_GUIDE_FILENAME = 'karst.uat-review-setup.md';

/** Where the runbook goes for a given manifest: its sibling. */
export function setupGuidePathFor(manifestPath: string): string {
  return join(dirname(manifestPath), SETUP_GUIDE_FILENAME);
}

/**
 * Write the runbook beside `manifestPath`, returning where it landed.
 *
 * Overwrites unconditionally: this is karst-generated reference, not user
 * config, and a copy left by an older install would describe behavior that has
 * since changed. Creates the parent so it does not depend on whether the
 * manifest was written first.
 */
export function writeSetupGuide(manifestPath: string, contents: string): string {
  const target = setupGuidePathFor(manifestPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}
