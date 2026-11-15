// The directory of the generated fixture pages (@ui:FIXTURE-SCOPE).
// A plain .mjs module, because serve.mjs runs under bare node. serve.mjs, buildFixture.ts and
// tmpCleanupReporter.ts read the same value.
//
// The docker gate scripts set KARST_VISUAL_TMP_DIR=/tmp/karst-visual-fixtures: the pages (about 1 GB) then
// stay on the container disk, not on the macOS bind mount, and `docker run --rm` removes them.

import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export const TMP_DIR_ENV = 'KARST_VISUAL_TMP_DIR';

const LEAF_PREFIX = 'karst-visual-';

// The fixture writer removes this directory at each start. Accept only a dedicated leaf directory:
// after path.resolve, the name starts with `karst-visual-` and the parent is the system temp directory
// or /tmp. An unset or empty variable gives `fallback`. Any other value throws, because a wrong value
// could remove a large tree.
export function fixtureDir(env, fallback) {
  const raw = env[TMP_DIR_ENV] ?? '';
  if (raw === '') return fallback;
  const value = resolve(raw);
  const parent = dirname(value);
  const inTempRoot = parent === resolve(tmpdir()) || parent === '/tmp';
  if (raw.split(/[\\/]/).includes('..') || !inTempRoot || !basename(value).startsWith(LEAF_PREFIX)) {
    throw new Error(
      `${TMP_DIR_ENV}="${raw}" is not accepted: use a directory whose name starts with "${LEAF_PREFIX}" directly in the temp directory, for example /tmp/karst-visual-fixtures.`,
    );
  }
  return value;
}
