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
const RUNTIME_FIELDS = ['start', 'health', 'healthIdentity', 'ports', 'dependsOn', 'portRange'] as const;

/**
 * A string that is required when `strict` (the repository is enabled), and
 * merely type-checked otherwise — absent/blank normalizes to `''` so a DRAFT
 * repository can leave the field empty without failing validation.
 */
function strictString(v: unknown, where: string, strict: boolean): string {
  if (strict) return requireString(v, where);
  if (v === undefined) return '';
  if (typeof v !== 'string') throw new ManifestError(`${where} must be a string`);
  return v;
}

/** A TCP port when `strict`; merely a well-typed number otherwise (0 = unset). */
function strictPort(v: unknown, where: string, strict: boolean): number {
  if (strict) return requirePort(v, where);
  if (v === undefined) return 0;
  if (typeof v !== 'number' || Number.isNaN(v)) throw new ManifestError(`${where} must be a number`);
  return v;
}

/** An array, non-empty when `strict`; merely array-typed otherwise. */
function strictArray(raw: unknown, where: string, strict: boolean): unknown[] {
  if (!Array.isArray(raw)) throw new ManifestError(`${where} must be an array`);
  return raw;
}

function validatePortSlot(raw: unknown, where: string, strict: boolean): PortSlot {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    name: strictString(raw.name, `${where}.name`, strict),
    env: strictString(raw.env, `${where}.env`, strict),
    default: strictPort(raw.default, `${where}.default`, strict),
  };
}

/**
 * An optional [min, max] port window narrowing the manifest-global portRange
 * for ONE service. Absent → allocation uses the global range. In DRAFT mode
 * (strict=false) only the two-number shape is checked, so a half-filled range
 * can be saved on a disabled repo — the same relaxation `strictPort` gives
 * `default: 0`.
 */
function validatePortRange(
  raw: unknown,
  where: string,
  strict: boolean,
): [number, number] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    typeof raw[0] !== 'number' ||
    typeof raw[1] !== 'number' ||
    Number.isNaN(raw[0]) ||
    Number.isNaN(raw[1])
  ) {
    throw new ManifestError(`${where} must be a [min, max] number pair`);
  }
  if (!strict) return [raw[0], raw[1]];
  const min = requirePort(raw[0], `${where} min`);
  const max = requirePort(raw[1], `${where} max`);
  if (min > max) {
    throw new ManifestError(`${where} min (${min}) exceeds max (${max})`);
  }
  return [min, max];
}

function validateBind(raw: unknown, where: string, strict: boolean): BindVar {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    env: strictString(raw.env, `${where}.env`, strict),
    template: strictString(raw.template, `${where}.template`, strict),
  };
}

function validateDependsOn(raw: unknown, repo: string, i: number, strict: boolean): DependsOn {
  const where = `repository "${repo}" service.dependsOn[${i}]`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  const bindRaw = strictArray(raw.bind, `${where}.bind`, strict);
  if (strict && bindRaw.length === 0) {
    throw new ManifestError(`${where}.bind must be a non-empty array`);
  }
  const bind = bindRaw.map((b, bi) => validateBind(b, `${where}.bind[${bi}]`, strict));

  if (strict) {
    assertUnique(
      bind.map((b) => b.env),
      (bi) => `${where}.bind[${bi}]`,
      'env',
    );
  }

  const target = strictString(raw.target, `${where}.target`, strict);
  if (target !== '' && target === repo) {
    throw new ManifestError(
      `${where} targets its own repository "${repo}" — a service cannot depend on itself`,
    );
  }

  return { target, port: strictString(raw.port, `${where}.port`, strict), bind };
}

/**
 * The runnable relation. `start` and a non-empty `ports` are required HERE
 * rather than at repository level: that is the whole inversion. A repository
 * omitting `service:` is valid; a repository declaring one must say how to run
 * it and on which port, or it cannot be started or addressed.
 */
function validateService(raw: unknown, repo: string, strict: boolean): ServiceDef {
  const where = `repository "${repo}" service`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  const start = strictString(raw.start, `${where}.start`, strict);
  // `health` is OPTIONAL, so blank means "not set" — the same normalization
  // every other optional string in this manifest uses (defaultModel,
  // ticketLabelTemplate, shipStatus). The settings UI seeds an empty input for
  // it, and reporting "must be a non-empty string" for a field that is not
  // required would send the author looking for a value they never owed.
  const health = optionalString(raw.health, `${where}.health`);
  // Opt-in, and only ever a boolean: a truthy string here would silently arm a
  // contract the service does not keep, and nothing would ever become healthy.
  const healthIdentity = optionalBoolean(raw.healthIdentity, `${where}.healthIdentity`);

  const portsRaw = strictArray(raw.ports, `${where}.ports`, strict);
  if (strict && portsRaw.length === 0) {
    throw new ManifestError(
      `${where}.ports must be a non-empty array — a declared service needs at least ` +
        `one port. If "${repo}" is not runnable, omit the whole \`service:\` block.`,
    );
  }
  const ports = portsRaw.map((p, i) => validatePortSlot(p, `${where}.ports[${i}]`, strict));
  const portRange = validatePortRange(raw.portRange, `${where}.portRange`, strict);

  if (strict) {
    assertUnique(ports.map((p) => p.name), (i) => `${where}.ports[${i}]`, 'name');
    assertUnique(ports.map((p) => p.env), (i) => `${where}.ports[${i}]`, 'env');
  }

  const dependsOnRaw = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOnRaw)) {
    throw new ManifestError(`${where}.dependsOn must be an array`);
  }

  return {
    start,
    health,
    healthIdentity,
    ports,
    portRange,
    dependsOn: dependsOnRaw.map((d, i) => validateDependsOn(d, repo, i, strict)),
  };
}

/** An optional boolean field: absent → undefined; a non-boolean throws. */
function optionalBoolean(raw: unknown, where: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw new ManifestError(`${where} must be a boolean`);
  return raw;
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

  // Draft state: `enabled: false` relaxes required-field checks below so an
  // incomplete repository can still be saved. Absent/anything-but-`false` is
  // enabled — same convention as ApproachDef.enabled / AgentDef.enabled.
  const enabled = raw.enabled !== false;

  const repo: RepositoryDef = {
    repoPath: strictString(raw.repoPath, `${where}.repoPath`, enabled),
    baselineBranch: optionalString(raw.baselineBranch, `${where}.baselineBranch`),
    hasMigrations: raw.hasMigrations === true, // default false
    signals: validateSignals(raw.signals, name),
    enabled,
    // Conventional-commit scope for `{scope}`; blank normalizes to undefined so
    // the renderer falls back to the repository name rather than emitting "()".
    scope: optionalString(raw.scope, `${where}.scope`),
  };

  return raw.service === undefined
    ? repo
    : { ...repo, service: validateService(raw.service, name, enabled) };
}
