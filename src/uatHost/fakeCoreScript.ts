import { readFileSync } from 'node:fs';
import type { FakeCoreScript } from '../agent/fakeCore.js';
import { parseFixtureFile } from './fixtureFile.js';

/**
 * Reads the `fakeCore` script of a fixture file. The path comes from the harness, which already
 * kept it inside the checkout (`run.mjs`); the content gets the same validation as `--fixture-file`.
 * A file with no `fakeCore` gives no script.
 */
export function loadFakeCoreScript(path: string): FakeCoreScript | undefined {
  return parseFixtureFile(JSON.parse(readFileSync(path, 'utf8')) as unknown, path).fakeCore;
}
