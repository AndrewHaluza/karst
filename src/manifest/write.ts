import { readFileSync, writeFileSync } from 'node:fs';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { validateManifest, ManifestError } from './schema.js';
import type { Manifest } from './types.js';

/**
 * Write repo-classifier signal words back into `.karst/karst.yml` for one
 * service (§ onboarding classify-gate). Read → mutate → validate → serialize →
 * write. Re-validating before write guarantees we never persist a manifest the
 * loader would reject.
 *
 * TRADEOFF: `js-yaml.dump` does not preserve comments, so the file may be
 * reformatted (comments dropped) on write. This is gated behind an explicit user
 * "approve" in the UI and touches only the edited service's `signals`; the
 * behavior is documented for authors.
 */
export function writeServiceSignals(path: string, service: string, signals: string[]): void {
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

  const root = parsed as Record<string, unknown>;
  const services = root.services;
  if (typeof services !== 'object' || services === null || Array.isArray(services)) {
    throw new ManifestError('services must be a mapping');
  }
  const svc = (services as Record<string, unknown>)[service];
  if (typeof svc !== 'object' || svc === null || Array.isArray(svc)) {
    throw new ManifestError(`service "${service}" not found`);
  }

  // Mutate a copy, not the parsed tree in place (immutable-update discipline).
  const nextServices = {
    ...(services as Record<string, unknown>),
    [service]: { ...(svc as Record<string, unknown>), signals: [...signals] },
  };
  const next = { ...root, services: nextServices };

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

  // Overlay each edited service onto its raw counterpart so unmodeled sub-keys
  // (e.g. author comments-as-values, future fields) survive.
  const rawServices = isRecord(root.services) ? root.services : {};
  const nextServices: Record<string, unknown> = {};
  for (const [name, svc] of Object.entries(manifest.services)) {
    const rawSvc = isRecord(rawServices[name]) ? rawServices[name] : {};
    nextServices[name] = {
      ...rawSvc,
      repoPath: svc.repoPath,
      start: svc.start,
      health: svc.health,
      ports: svc.ports,
      dependsOn: svc.dependsOn,
      hasMigrations: svc.hasMigrations,
      signals: svc.signals ?? [],
    };
  }

  const next = {
    ...root, // preserve unknown top-level keys
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
    services: nextServices,
    approaches: manifest.approaches ?? [],
    agents: manifest.agents ?? {},
    ticketing: manifest.ticketing ?? { provider: 'manual' },
    agentProvider: manifest.agentProvider ?? 'claude',
  };

  // Re-validate before persisting — never write a file the loader would reject.
  validateManifest(next);
  writeFileSync(path, yamlDump(next));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
