/**
 * Shared narrowing helpers for manifest validation.
 *
 * Each takes the raw value plus a `where` breadcrumb (e.g.
 * `repository "api" service.ports[0].env`) so the thrown message points at the
 * exact field the author has to fix, not just "invalid manifest".
 */

import { ManifestError } from '../error.js';

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ManifestError(`${where} must be a non-empty string`);
  }
  return v;
}

export function requireNumber(v: unknown, where: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new ManifestError(`${where} must be a number`);
  }
  return v;
}

/**
 * A TCP port: an integer in 1-65535. Previously any number was accepted, so a
 * typo'd `0` or `70000` reached the spawn and failed as an opaque EACCES /
 * RangeError from the OS instead of as a manifest error.
 */
export function requirePort(v: unknown, where: string): number {
  const n = requireNumber(v, where);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ManifestError(`${where} must be an integer between 1 and 65535 (got ${n})`);
  }
  return n;
}

/** A required, non-empty array of non-empty strings at `${where}.${field}`. */
export function requireStringArray(raw: unknown, where: string, field: string): string[] {
  const full = `${where}.${field}`;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ManifestError(`${full} must be a non-empty array of strings`);
  }
  return raw.map((s, i) => requireString(s, `${full}[${i}]`));
}

/** An array of non-empty strings at `${where}.${field}`; empty is allowed. */
export function requireStringArrayAllowEmpty(
  raw: unknown,
  where: string,
  field: string,
): string[] {
  const full = `${where}.${field}`;
  if (!Array.isArray(raw)) {
    throw new ManifestError(`${full} must be an array of strings`);
  }
  return raw.map((s, i) => requireString(s, `${full}[${i}]`));
}

/**
 * Reject a duplicate within one collection, naming both positions. Used for port
 * slot names, port env vars, and bind env vars — each a case where the old
 * schema silently let the later entry win, producing a stack wired to a port
 * nobody declared.
 */
export function assertUnique(
  values: string[],
  where: (index: number) => string,
  what: string,
): void {
  const seen = new Map<string, number>();
  values.forEach((value, i) => {
    const first = seen.get(value);
    if (first !== undefined) {
      throw new ManifestError(
        `${where(i)} ${what} "${value}" duplicates ${where(first)}`,
      );
    }
    seen.set(value, i);
  });
}
