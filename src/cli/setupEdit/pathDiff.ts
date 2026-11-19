/**
 * A generic field-path diff of two manifest trees (@arch:CLI-21). A leaf is a
 * scalar or an array; a mapping is walked. No per-field code: a field added to
 * the manifest later shows in the popup with no change here.
 */

import { isDeepStrictEqual } from 'node:util';

export interface PathChange {
  /** `repositories.web.service.healthTimeoutSeconds` */
  path: string;
  /** `undefined` when the path is new. */
  before: unknown;
  /** `undefined` when the path is gone. */
  after: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tree as plain JSON: a key set to `undefined` equals an absent key. */
const plain = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function diffPaths(before: unknown, after: unknown): PathChange[] {
  const out: PathChange[] = [];
  walk(plain(before), plain(after), '', out);
  return out;
}

function walk(before: unknown, after: unknown, path: string, out: PathChange[]): void {
  if (isDeepStrictEqual(before, after)) return;
  if (isRecord(before) && isRecord(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      walk(before[key], after[key], path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }
  // A mapping that appears or disappears lists its leaves, so every added field is named.
  if (isRecord(before) && after === undefined && Object.keys(before).length > 0) return void spread(before, path, out, 'removed');
  if (isRecord(after) && before === undefined && Object.keys(after).length > 0) return void spread(after, path, out, 'added');
  out.push({ path, before, after });
}

function spread(tree: Record<string, unknown>, path: string, out: PathChange[], kind: 'added' | 'removed'): void {
  for (const key of Object.keys(tree).sort()) {
    const here = path === '' ? key : `${path}.${key}`;
    const value = tree[key];
    if (isRecord(value)) spread(value, here, out, kind);
    else out.push(kind === 'added' ? { path: here, before: undefined, after: value } : { path: here, before: value, after: undefined });
  }
}

/** The top-level manifest key of a path. */
export const topKey = (path: string): string => path.split('.')[0]!;

/** `value` as the popup prints it. */
export function formatValue(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

export function formatChange(change: PathChange): string {
  return `${change.path}: ${formatValue(change.before)} -> ${formatValue(change.after)}`;
}
