/**
 * Validation for a service's `docker:` block.
 *
 * Separate from `repository.ts` for the same reason the block itself exists: a
 * container service is described by a different set of facts (an image, a port
 * INSIDE it, mounts) than a command service, and mixing the two validators would
 * make the required-field rules of each harder to read than either deserves.
 *
 * Strictness follows the repository's `enabled` flag exactly as everything else
 * here does: a DRAFT (disabled) repository may be saved half-filled, an enabled
 * one may not — an image nobody named, or a container port nobody gave, is a
 * service karst could only fail to start.
 */

import { ManifestError } from '../error.js';
import type { DockerDef } from '../types.js';
import { isObject, requirePort, requireString } from './primitives.js';

/** `-e` variables: a flat string→string map. Absent → `{}`. */
function validateEnv(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object of string values`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // Numbers and booleans are the tempting coercion here, and the reason not to
    // coerce is that YAML would decide silently: `POSTGRES_PASSWORD: 0123` is a
    // number, and the container would receive `83`. Quote it, and say so.
    if (typeof value !== 'string') {
      throw new ManifestError(`${where}.${key} must be a string (quote the value)`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * `-v` mounts. Each entry must carry a destination: a bare `./data` is Docker's
 * ANONYMOUS-volume syntax, which silently mounts nothing the author can find
 * again — the opposite of what someone writing a path meant.
 */
function validateVolumes(raw: unknown, where: string, strict: boolean): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError(`${where} must be an array`);
  return raw.map((entry, i) => {
    if (typeof entry !== 'string') throw new ManifestError(`${where}[${i}] must be a string`);
    if (strict && !/^[^:]+:\/[^:]*/.test(entry.trim())) {
      throw new ManifestError(
        `${where}[${i}] must be "<source>:<absolute path in the container>" — ` +
          `"${entry}" names no destination inside the container.`,
      );
    }
    return entry.trim();
  });
}

/** Command/arguments after the image. Absent → `[]`. */
function validateArgs(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError(`${where} must be an array`);
  return raw.map((a, i) => requireString(a, `${where}[${i}]`));
}

/** Parse a service's `docker:` block. `strict` mirrors the repository's `enabled`. */
export function validateDocker(raw: unknown, where: string, strict: boolean): DockerDef {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  const image = strict
    ? requireString(raw.image, `${where}.image`)
    : typeof raw.image === 'string'
      ? raw.image
      : '';
  if (!strict && raw.image !== undefined && typeof raw.image !== 'string') {
    throw new ManifestError(`${where}.image must be a string`);
  }
  const containerPort = strict
    ? requirePort(raw.containerPort, `${where}.containerPort`)
    : typeof raw.containerPort === 'number' && !Number.isNaN(raw.containerPort)
      ? raw.containerPort
      : 0;
  if (
    !strict &&
    raw.containerPort !== undefined &&
    (typeof raw.containerPort !== 'number' || Number.isNaN(raw.containerPort))
  ) {
    throw new ManifestError(`${where}.containerPort must be a number`);
  }

  return {
    image,
    containerPort,
    env: validateEnv(raw.env, `${where}.env`),
    volumes: validateVolumes(raw.volumes, `${where}.volumes`, strict),
    args: validateArgs(raw.args, `${where}.args`),
  };
}
