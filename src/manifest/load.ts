import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import type { Manifest } from './types.js';
import { validateManifest, ManifestError } from './schema.js';

export type { Manifest } from './types.js';
export { ManifestError } from './schema.js';

/**
 * Load and validate `karst.yml` into a typed model (§7.1). Throws ManifestError
 * with a specific message on any malformed input — validate at the boundary,
 * never trust the file.
 */
export function loadManifest(path: string): Manifest {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ManifestError(`cannot read ${path}: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (e) {
    throw new ManifestError(`YAML parse failed: ${(e as Error).message}`);
  }

  return validateManifest(parsed);
}
