/**
 * Per-repository validation: the repository itself, and its optional `service:`
 * relation.
 *
 * The rule that gives the model its teeth is `assertNoStrayRuntimeFields`. The
 * nesting alone makes "port without a service" unrepresentable in the TYPE, but
 * YAML is not typed — an author half-migrating a file leaves `start:` at
 * repository level, where it would simply be ignored. Ignoring it would mean the
 * repo silently becomes non-runnable and nothing ever starts. So a stray runtime
 * field is a hard error that says exactly where to move it.
 */

import { ManifestError } from '../error.js';
import type {
  BindVar,
  DependsOn,
  PortSlot,
  RepositoryDef,
  ServiceDef,
} from '../types.js';
import {
  assertUnique,
  isObject,
  requirePort,
  requireString,
} from './primitives.js';

/** Runtime fields that belong under `service:` and nowhere else. */
const RUNTIME_FIELDS = ['start', 'health', 'ports', 'dependsOn'] as const;

function validatePortSlot(raw: unknown, where: string): PortSlot {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    name: requireString(raw.name, `${where}.name`),
    env: requireString(raw.env, `${where}.env`),
    default: requirePort(raw.default, `${where}.default`),
  };
}

function validateBind(raw: unknown, where: string): BindVar {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    env: requireString(raw.env, `${where}.env`),
    template: requireString(raw.template, `${where}.template`),
  };
}

function validateDependsOn(raw: unknown, repo: string, i: number): DependsOn {
  const where = `repository "${repo}" service.dependsOn[${i}]`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  const bindRaw = raw.bind;
  if (!Array.isArray(bindRaw) || bindRaw.length === 0) {
    throw new ManifestError(`${where}.bind must be a non-empty array`);
  }
  const bind = bindRaw.map((b, bi) => validateBind(b, `${where}.bind[${bi}]`));

  // Two binds writing the same env var: one silently wins at spawn, and which
  // one depends on iteration order. Never useful, always a mistake.
  assertUnique(
    bind.map((b) => b.env),
    (bi) => `${where}.bind[${bi}]`,
    'env',
  );

  const target = requireString(raw.target, `${where}.target`);
  if (target === repo) {
    throw new ManifestError(
      `${where} targets its own repository "${repo}" — a service cannot depend on itself`,
    );
  }

  return { target, port: requireString(raw.port, `${where}.port`), bind };
}

/**
 * The runnable relation. `start` and a non-empty `ports` are required HERE
 * rather than at repository level: that is the whole inversion. A repository
 * omitting `service:` is valid; a repository declaring one must say how to run
 * it and on which port, or it cannot be started or addressed.
 */
function validateService(raw: unknown, repo: string): ServiceDef {
  const where = `repository "${repo}" service`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  const portsRaw = raw.ports;
  if (!Array.isArray(portsRaw) || portsRaw.length === 0) {
    throw new ManifestError(
      `${where}.ports must be a non-empty array — a declared service needs at least ` +
        `one port. If "${repo}" is not runnable, omit the whole \`service:\` block.`,
    );
  }
  const ports = portsRaw.map((p, i) => validatePortSlot(p, `${where}.ports[${i}]`));

  // Slot names are referenced by dependsOn.port; env vars are injected at spawn.
  // A duplicate in either silently shadows the earlier entry.
  assertUnique(ports.map((p) => p.name), (i) => `${where}.ports[${i}]`, 'name');
  assertUnique(ports.map((p) => p.env), (i) => `${where}.ports[${i}]`, 'env');

  const dependsOnRaw = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOnRaw)) {
    throw new ManifestError(`${where}.dependsOn must be an array`);
  }

  return {
    start: requireString(raw.start, `${where}.start`),
    // `health` is OPTIONAL, so blank means "not set" — the same normalization
    // every other optional string in this manifest uses (defaultModel,
    // ticketLabelTemplate, shipStatus). The settings UI seeds an empty input for
    // it, and reporting "must be a non-empty string" for a field that is not
    // required would send the author looking for a value they never owed.
    health: optionalString(raw.health, `${where}.health`),
    ports,
    dependsOn: dependsOnRaw.map((d, i) => validateDependsOn(d, repo, i)),
  };
}

/**
 * An optional string field: absent OR blank → undefined; a non-string still
 * throws, so a typo'd type is never silently swallowed.
 */
function optionalString(raw: unknown, where: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ManifestError(`${where} must be a string`);
  return raw.trim() === '' ? undefined : raw;
}

/** Parse a repository's `signals`: an array of non-empty strings, default []. */
function validateSignals(raw: unknown, repo: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ManifestError(`repository "${repo}" signals must be an array of strings`);
  }
  return raw.map((s, i) => requireString(s, `repository "${repo}" signals[${i}]`));
}

/**
 * Catch a half-migrated file. A runtime field at repository level is inert under
 * the new schema, so accepting it would quietly turn a runnable repo into a
 * non-runnable one — the exact silent misinterpretation this model must not
 * allow. Name the field and where it goes.
 */
function assertNoStrayRuntimeFields(raw: Record<string, unknown>, repo: string): void {
  for (const field of RUNTIME_FIELDS) {
    if (raw[field] !== undefined) {
      throw new ManifestError(
        `repository "${repo}" has runtime field "${field}" at repository level; ` +
          `move it under \`service:\`. (If "${repo}" is not runnable, delete it.)`,
      );
    }
  }
}

/** Validate one entry of the top-level `repositories:` map. */
export function validateRepository(raw: unknown, name: string): RepositoryDef {
  const where = `repository "${name}"`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  assertNoStrayRuntimeFields(raw, name);

  const repo: RepositoryDef = {
    repoPath: requireString(raw.repoPath, `${where}.repoPath`),
    hasMigrations: raw.hasMigrations === true, // default false
    signals: validateSignals(raw.signals, name),
  };

  // Absent `service:` is the non-runnable case and entirely valid. Only build
  // the relation when the author actually declared one.
  return raw.service === undefined
    ? repo
    : { ...repo, service: validateService(raw.service, name) };
}
