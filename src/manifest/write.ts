import { readFileSync, writeFileSync } from 'node:fs';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { validateManifest, DEFAULT_ARCHIVE_DONE_AFTER_DAYS } from './schema.js';
import { ManifestError } from './error.js';
import { migrateLegacyManifest } from './migrate.js';
import type { Manifest } from './types.js';

/**
 * Write repo-classifier signal words back into `.karst/karst.yml` for one
 * repository (§ ticket-form classify-gate). Read → migrate → copy → validate →
 * serialize → write. Re-validating before write guarantees we never persist a
 * manifest the loader would reject.
 *
 * TRADEOFF: `js-yaml.dump` does not preserve comments, so the file may be
 * reformatted (comments dropped) on write. This is gated behind an explicit user
 * "approve" in the UI and touches only the edited repository's `signals`; the
 * behavior is documented for authors.
 */
export function writeRepoSignals(path: string, repository: string, signals: string[]): void {
  // Validate the incoming signals up front so a bad write never touches the file.
  for (const [i, s] of signals.entries()) {
    if (typeof s !== 'string' || s.length === 0) {
      throw new ManifestError(`signal[${i}] must be a non-empty string`);
    }
  }

  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (e) {
    throw new ManifestError(`YAML parse failed: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ManifestError('top level must be a mapping');
  }

  // Upgrade a legacy file in passing, so signals can be written to it without
  // leaving a `services:` key the loader would then reject alongside the new one.
  const migrated = migrateLegacyManifest(parsed as Record<string, unknown>).raw;
  const root = isRecord(migrated) ? migrated : {};
  const repositories = root.repositories;
  if (typeof repositories !== 'object' || repositories === null || Array.isArray(repositories)) {
    throw new ManifestError('repositories must be a mapping');
  }
  const repo = (repositories as Record<string, unknown>)[repository];
  if (typeof repo !== 'object' || repo === null || Array.isArray(repo)) {
    throw new ManifestError(`repository "${repository}" not found`);
  }

  // Copy, never mutate the parsed tree in place (immutable-update discipline).
  const nextRepos = {
    ...(repositories as Record<string, unknown>),
    [repository]: { ...(repo as Record<string, unknown>), signals: [...signals] },
  };
  const next = { ...root, repositories: nextRepos };

  // Re-validate the whole manifest before persisting — never write a file the
  // loader would later reject.
  validateManifest(next);

  writeFileSync(path, yamlDump(next));
}

/**
 * Persist an edited `Manifest` to `karst.yml` using MERGE-OVER-RAW: read the
 * raw YAML tree, overlay only the modeled sections, and keep every other
 * top-level key + unmodeled service sub-key intact. Re-validate the merged tree
 * before writing so we never persist a manifest the loader would reject.
 *
 * TRADEOFF: `js-yaml.dump` drops comments; the file may be reformatted on write.
 * This is gated behind an explicit "Save" in the settings UI.
 */
export function writeManifest(path: string, manifest: Manifest): void {
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (e) {
    throw new ManifestError(`YAML parse failed: ${(e as Error).message}`);
  }
  const root = isRecord(parsed) ? parsed : {};

  // A legacy file is upgraded on write: migrating the raw tree first means the
  // overlay lines up with `repositories`, and the stale `services:` key is gone
  // rather than left behind to make the file fail its own validation on reload.
  const migratedRaw = migrateLegacyManifest(root).raw;
  const migrated = isRecord(migratedRaw) ? migratedRaw : {};
  const rawRepos = isRecord(migrated.repositories) ? migrated.repositories : {};
  const rawConventions = isRecord(migrated.conventions) ? migrated.conventions : {};

  // Overlay each edited repository onto its raw counterpart so unmodeled
  // sub-keys (author comments-as-values, future fields) survive.
  const nextRepos: Record<string, unknown> = {};
  for (const [name, repo] of Object.entries(manifest.repositories)) {
    const rawRepo = isRecord(rawRepos[name]) ? rawRepos[name] : {};
    const rawService = isRecord(rawRepo.service) ? rawRepo.service : {};
    nextRepos[name] = {
      ...rawRepo,
      repoPath: repo.repoPath,
      baselineBranch: repo.baselineBranch,
      hasMigrations: repo.hasMigrations,
      signals: repo.signals ?? [],
      // Write enabled only when false (draft mode); true is the default and
      // omitting it keeps the file cleaner. Undefined→omitted so stale enabled:true
      // (if it existed) gets dropped.
      enabled: repo.enabled === false ? false : undefined,
      // Optional: written when set, dropped when cleared (→ falls back to name).
      scope: repo.scope,
      // Undefined (not omitted) so the dumper DROPS a `service:` block the user
      // just turned off — leaving the raw one would silently keep the repo
      // runnable after they said it wasn't.
      service: repo.service
        ? {
            ...rawService,
            start: repo.service.start,
            health: repo.service.health,
            ports: repo.service.ports,
            dependsOn: repo.service.dependsOn,
          }
        : undefined,
    };
  }

  const next = {
    ...migrated, // preserve unknown top-level keys (and drop the legacy `services:`)
    // Optional: written when set, dropped (→ omitted by the dumper) when cleared,
    // so the host falls back to the path-derived slug.
    id: manifest.id,
    host: manifest.host,
    portRange: manifest.portRange,
    baselineBranch: manifest.baselineBranch,
    worktreePathDisplay: manifest.worktreePathDisplay ?? 'relative',
    // Optional: written when set, dropped (undefined → omitted by the dumper, and
    // overrides any stale root value) when cleared, so it falls back to default.
    ticketLabelTemplate: manifest.ticketLabelTemplate,
    // Optional: written when set, dropped when cleared, falls back to default.
    terminalNameTemplate: manifest.terminalNameTemplate,
    // Optional: written when set, dropped (→ omitted by the dumper) when cleared,
    // so it falls back to "no default".
    defaultModel: manifest.defaultModel,
    // Always written (validated manifests carry the default), like
    // `worktreePathDisplay` — without this line Save silently drops the key and
    // the next reload falls back to the default.
    archiveDoneAfterDays:
      manifest.archiveDoneAfterDays ?? DEFAULT_ARCHIVE_DONE_AFTER_DAYS,
    // Merge modeled convention fields over the raw block so future/unmodeled
    // nested keys survive Settings saves. Each modeled child is assigned even
    // when absent so clearing one field drops its stale raw value. Clearing the
    // parent removes the entire block, including unknown nested keys, because
    // that is the user's explicit "no conventions" state.
    conventions: manifest.conventions
      ? {
          ...rawConventions,
          branchName: manifest.conventions.branchName,
          defaultType: manifest.conventions.defaultType,
          commitMessage: manifest.conventions.commitMessage,
          pullRequestTitle: manifest.conventions.pullRequestTitle,
          pullRequestDescription: manifest.conventions.pullRequestDescription,
        }
      : undefined,
    repositories: nextRepos,
    approaches: manifest.approaches ?? [],
    agents: manifest.agents ?? {},
    ticketing: manifest.ticketing ?? { provider: 'manual' },
    agentProvider: manifest.agentProvider ?? 'claude',
    // Without this line Save silently drops the whole block — the failure mode
    // the writeManifest round-trip test exists to catch.
    uat: manifest.uat,
    review: manifest.review,
    // Same seam, same failure mode: the Agents tab owns `processes`, and an
    // explicit save must never drop the block (writeManifest.test.ts pins it).
    processes: manifest.processes,
  };

  // Re-validate before persisting — never write a file the loader would reject.
  validateManifest(next);
  writeFileSync(path, yamlDump(next));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
