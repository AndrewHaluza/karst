/**
 * Legacy `services:` → `repositories:` translation, applied to the RAW YAML tree
 * before validation.
 *
 * Every karst.yml written before repositories became the primary entity uses a
 * top-level `services:` map with the runtime fields flat on each entry. Those
 * files must keep working, and — more importantly — must never be silently
 * MISREAD. Two properties make that safe:
 *
 *  1. The translation is lossless and unambiguous. The old schema required both
 *     `start` and a non-empty `ports`, so every legacy entry maps to exactly one
 *     repository that HAS a service. There is no legacy file whose intent is
 *     "not runnable", so nothing has to be guessed.
 *  2. A file carrying BOTH keys is rejected outright. That is not a legacy file
 *     and not a new one; picking either would be inventing an answer.
 *
 * The translation happens in memory only. Rewriting the user's file on load
 * would turn a read into a write and silently drop their comments (js-yaml's
 * dumper does not preserve them). `writeManifest` performs the on-disk upgrade
 * the next time the user explicitly saves.
 */

import { ManifestError } from './schema.js';

/** Fields that lived flat on a legacy service and now belong under `service:`. */
const RUNTIME_FIELDS = ['start', 'health', 'ports', 'dependsOn'] as const;

/** Fields that describe the source tree and stay at repository level. */
const REPO_FIELDS = ['repoPath', 'hasMigrations', 'signals'] as const;

export interface MigrationResult {
  /**
   * The tree to validate: `repositories`-shaped either way. Typed `unknown`
   * because a non-mapping input is passed straight through — inventing an empty
   * mapping here would swallow validation's "top level must be a mapping".
   */
  raw: unknown;
  /** Deprecation notices for the host to surface. Empty when nothing moved. */
  warnings: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Translate one legacy service entry into a repository entry.
 *
 * Unmodeled sub-keys are preserved at REPOSITORY level rather than being
 * dropped or guessed into the service — they were authored against a flat
 * shape, so repository level is the only placement that cannot invent meaning.
 */
function translateEntry(raw: unknown): unknown {
  if (!isObject(raw)) return raw; // let validation report the real fault

  const service: Record<string, unknown> = {};
  const repository: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if ((RUNTIME_FIELDS as readonly string[]).includes(key)) {
      // `health` is optional and absent-vs-undefined matters to the dumper.
      if (value !== undefined) service[key] = value;
    } else if ((REPO_FIELDS as readonly string[]).includes(key)) {
      repository[key] = value;
    } else {
      repository[key] = value; // unmodeled: keep it where it was authored
    }
  }

  // A legacy entry always described something runnable. Only emit `service` when
  // at least one runtime field was present, so a hand-written half-file still
  // reaches validation and gets a precise error rather than an empty service.
  return Object.keys(service).length > 0 ? { ...repository, service } : repository;
}

/**
 * Normalize a parsed karst.yml to the `repositories:` shape.
 *
 * Never mutates `raw`; returns a new tree. Throws `ManifestError` only for the
 * both-keys case — every other fault is left for `validateManifest`, which has
 * the field-level vocabulary to describe it.
 */
export function migrateLegacyManifest(raw: unknown): MigrationResult {
  // Not a mapping: nothing to translate, and validation owns the error message.
  if (!isObject(raw)) return { raw, warnings: [] };

  const hasLegacy = raw.services !== undefined;
  const hasCurrent = raw.repositories !== undefined;

  if (hasLegacy && hasCurrent) {
    throw new ManifestError(
      'declares both `repositories:` and the legacy `services:` key. ' +
        'Karst will not guess which one is authoritative — delete `services:` ' +
        'once its entries have been moved under `repositories:`.',
    );
  }

  if (!hasLegacy) return { raw, warnings: [] };

  if (!isObject(raw.services)) {
    // Malformed legacy key: hand it to validation under the new name so the
    // error names `repositories`, which is what the author must now write.
    const { services: _dropped, ...rest } = raw;
    return { raw: { ...rest, repositories: raw.services }, warnings: [] };
  }

  const repositories: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw.services)) {
    repositories[name] = translateEntry(entry);
  }

  const { services: _legacy, ...rest } = raw;
  return {
    raw: { ...rest, repositories },
    warnings: [
      'uses the legacy `services:` key. It was read as `repositories:` with ' +
        'each entry\'s start/health/ports/dependsOn moved under `service:`. ' +
        'Save from Karst Settings to write the new shape to disk.',
    ],
  };
}
