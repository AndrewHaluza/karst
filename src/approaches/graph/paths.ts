/**
 * Pure-string normalizer for graph-relative paths (Slice 2 Task 3).
 *
 * Artifact paths normalize relative to the runtime-owned artifact root;
 * resource paths relative to their declared repository root. Neither accepts
 * absolute paths, empty/dot segments, `..`, or glob expressions, and both
 * reject the Windows alias set — drive/UNC escapes, alternate data streams,
 * reserved device names, trailing dots/spaces, and inconsistent
 * case/Unicode-normalization aliases. No Windows runtime support is asserted
 * for V1; these are pure-string rejections (design, "Node IDs and paths").
 *
 * This module is pure: it imports no store, no vscode, no provider.
 */

export type NormalizePathResult =
  | { ok: true; value: string }
  | { ok: false; code: 'invalid-path' | 'windows-path-alias' | 'glob-path' };

const DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const GLOB_CHARS = /[*?[{]/;

/** True when the string is not NFC-canonical — a byte-distinct alias for
 *  the same file on a normalization-insensitive filesystem. */
function isNfcAlias(value: string): boolean {
  return value.normalize('NFC') !== value;
}

function hasReservedDeviceSegment(segments: string[]): boolean {
  for (const segment of segments) {
    const base = segment.split('.')[0]!;
    if (DEVICE_NAMES.test(base)) return true;
  }
  return false;
}

function hasTrailingDotOrSpace(segments: string[]): boolean {
  for (const segment of segments) {
    if (/[. ]$/.test(segment)) return true;
  }
  return false;
}

export function normalizeGraphPath(input: string): NormalizePathResult {
  // Drive/UNC/backslash/ADS checks run first so an alias is named as such
  // rather than as a structure defect.
  if (/^[a-zA-Z]:/.test(input)) return { ok: false, code: 'windows-path-alias' };
  if (input.startsWith('//')) return { ok: false, code: 'windows-path-alias' };
  if (input.includes('\\')) return { ok: false, code: 'windows-path-alias' };
  if (input.includes(':')) return { ok: false, code: 'windows-path-alias' };

  // Structure: relative, no empty/dot segments, no `..`.
  if (input === '' || input.startsWith('/')) return { ok: false, code: 'invalid-path' };
  const segments = input.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, code: 'invalid-path' };
    }
  }

  // Windows alias checks over structurally valid segments: reserved device
  // names, trailing dots/spaces, Unicode-normalization aliases.
  if (hasReservedDeviceSegment(segments)) return { ok: false, code: 'windows-path-alias' };
  if (hasTrailingDotOrSpace(segments)) return { ok: false, code: 'windows-path-alias' };
  if (isNfcAlias(input)) return { ok: false, code: 'windows-path-alias' };

  // Exact files or directory subtrees, never glob expressions.
  if (GLOB_CHARS.test(input)) return { ok: false, code: 'glob-path' };

  return { ok: true, value: input };
}
