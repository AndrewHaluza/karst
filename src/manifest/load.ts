import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import type { Manifest } from './types.js';
import { validateManifest } from './schema.js';
import { ManifestError } from './error.js';
import { migrateLegacyManifest } from './migrate.js';

export type { Manifest } from './types.js';
export { ManifestError } from './error.js';

export interface LoadedManifestResult {
  manifest: Manifest;
  /**
   * Non-fatal notices — today, that the file still uses the legacy `services:`
   * key. The host surfaces these; the CLI writes them to stderr. Empty for a
   * current file.
   */
  warnings: string[];
}

/**
 * Load `karst.yml` into a typed model, reporting any non-fatal diagnostics.
 *
 * Order matters: read → parse → MIGRATE → validate. Migrating first means the
 * validator only ever sees one shape, so it never has to carry two vocabularies
 * or guess which one an error refers to.
 *
 * Every `ManifestError` leaves here carrying the file path. Validators throw
 * without it (they only know field names), and a user may have several
 * manifests — being told "portRange must be a [min, max] number pair" without
 * knowing WHICH file is not actionable.
 */
export function loadManifestWithDiagnostics(path: string): LoadedManifestResult {
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
    throw new ManifestError(`YAML parse failed: ${(e as Error).message}`, path);
  }

  try {
    const { raw, warnings } = migrateLegacyManifest(parsed);
    return { manifest: validateManifest(raw), warnings };
  } catch (e) {
    throw e instanceof ManifestError ? e.withPath(path) : e;
  }
}

/**
 * Load and validate `karst.yml` into a typed model (§7.1). Throws ManifestError
 * with a specific message on any malformed input — validate at the boundary,
 * never trust the file.
 *
 * Diagnostics are dropped; callers that can surface them should use
 * `loadManifestWithDiagnostics`.
 */
export function loadManifest(path: string): Manifest {
  return loadManifestWithDiagnostics(path).manifest;
}
