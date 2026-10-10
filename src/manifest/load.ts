import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import type { Manifest } from './types.js';
import { validateManifest } from './schema.js';
import { ManifestError } from './error.js';
import { migrateLegacyManifest } from './migrate.js';
import { foldProcessRows } from './foldProcessRows.js';
import { detectInertKeys } from './inertKeys.js';
import { uatEnvWarnings } from './validate/uat.js';
import { deprecatedPresetKeyWarnings } from './validate/agentPresets.js';

export type { Manifest } from './types.js';
export { ManifestError } from './error.js';

export interface LoadedManifestResult {
  manifest: Manifest;
  /**
   * Non-fatal problems: the file uses the legacy `services:` key, or a
   * `uat.env` value looks like a pasted credential. Something the author
   * should change.
   */
  warnings: string[];
  /**
   * Non-fatal FACTS: keys the file declares that no code reads yet (D1). Not a
   * problem and not the author's mistake, so kept out of `warnings` — a project
   * configuring UAT ahead of Phase 2 must not read as broken. INFO, mirroring
   * `catalogDiagnosticSeverity`'s split.
   */
  notices: string[];
  /**
   * True when `processes.<role>` core fields were folded into presets/pins on
   * this load (`foldProcessRows`). The in-memory manifest is migrated; the file
   * is not — the Settings host persists it when the page opens.
   */
  migrated: boolean;
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
  return parseManifestText(text, path);
}

/**
 * Parse + migrate + validate manifest TEXT (no file read). The setup session's
 * proposal carries the raw YAML text, so the host can validate it before
 * applying without a temp file. `path` is only used to attribute an error.
 */
export function parseManifestText(text: string, path?: string): LoadedManifestResult {
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (e) {
    throw new ManifestError(`YAML parse failed: ${(e as Error).message}`, path);
  }

  try {
    const { raw: migrated, warnings } = migrateLegacyManifest(parsed);
    // Unpinned `processes.<role>` core fields move into presets (or a pin)
    // BEFORE validation, which refuses them on an unpinned row.
    const { raw, notices: folded } = foldProcessRows(migrated);
    const manifest = validateManifest(raw);
    return {
      manifest,
      // uatEnvWarnings has existed since UAT landed and was called by nothing,
      // so this check has never run. It is a warning, never a block: it cannot
      // be reliable, and the mistake it catches is the likely one.
      warnings: [
        ...warnings,
        ...(manifest.uat ? uatEnvWarnings(manifest.uat) : []),
        // §6: `processes.<key>.preset` is deprecated but still honoured.
        ...deprecatedPresetKeyWarnings(manifest.processes),
      ],
      notices: [...folded, ...detectInertKeys(raw)],
      migrated: folded.length > 0,
    };
  } catch (e) {
    throw e instanceof ManifestError ? (path ? e.withPath(path) : e) : e;
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
