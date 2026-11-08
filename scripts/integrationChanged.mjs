// Run the integration tests related to the src files this ticket changed, before the impl marker.
// Usage: node scripts/integrationChanged.mjs   (npm run -s test:integration:changed)
// Scope: files changed against the merge base with the base branch, uncommitted and untracked included.
// It runs vitest directly, not through vitestGate.mjs, so the gate state of test:integration stays as it is.
// Exit: 0 with no changed src file, otherwise the vitest status.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { changedSince, mergeBase, runTool } from './gateScope.mjs';
import { classifyPath } from './gateState.mjs';

/** The changed paths that select tests: code files under src that still exist (a deleted file cannot relate). */
export function selectChangedSrc(changed, exists = () => true) {
  return changed.filter((path) => path.startsWith('src/') && classifyPath(path).kind === 'code' && exists(path)).sort();
}

/** The vitest args for the related run. */
export function relatedArgs(files) {
  return ['vitest', 'related', '--run', '--passWithNoTests', '--config', 'vitest.integration.config.ts', ...files];
}

/** The one scope line. */
export const scopeMessage = (files, base) =>
  files.length === 0 ? 'integration:changed: no changed src file, nothing to run' : `integration:changed: ${files.length} changed src files since ${base.slice(0, 12)}`;

async function main() {
  const cwd = process.cwd();
  const { sha, tried } = await mergeBase(cwd);
  if (sha === null) {
    console.error(`integration:changed: no merge base for ${tried.join(', ')}`);
    process.exit(1);
  }
  const changed = await changedSince(cwd, sha);
  if (changed === null) {
    console.error('integration:changed: git diff failed');
    process.exit(1);
  }
  const files = selectChangedSrc(changed, (path) => existsSync(join(cwd, path)));
  console.error(scopeMessage(files, sha));
  if (files.length === 0) process.exit(0);
  process.exit(await runTool('npx', relatedArgs(files), cwd));
}

if (process.argv[1] && process.argv[1].endsWith('integrationChanged.mjs')) await main();
