/**
 * Field-level mutation of a raw manifest document, for the conformance test:
 * every path of the document is replaced by a set of invalid or edge values,
 * deleted, and (for a mapping) given an unknown key.
 */

import type { Raw } from './richManifest.js';

export interface Mutation {
  /** Dotted path of the mutated value, e.g. `repositories.api.services.server.ports.0.default`. */
  path: string;
  /** What was done to it, e.g. `set:null`, `delete`, `unknown-key`. */
  how: string;
  document: Raw;
}

export const REPLACEMENTS: readonly [string, unknown][] = [
  ['null', null],
  ['true', true],
  ['false', false],
  ['string', 'x'],
  ['empty-string', ''],
  ['blank-string', '  '],
  ['zero', 0],
  ['one', 1],
  ['negative', -1],
  ['fraction', 1.5],
  ['big', 70000],
  ['empty-array', []],
  ['string-array', ['x']],
  ['empty-object', {}],
];

const UNKNOWN_KEY = '__unknown__';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parentOf(document: Raw, keys: readonly string[]): Record<string, unknown> {
  let node: unknown = document;
  for (const key of keys.slice(0, -1)) node = (node as Record<string, unknown>)[key];
  return node as Record<string, unknown>;
}

function walk(value: unknown, keys: string[], out: string[][]): void {
  out.push(keys);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...keys, String(i)], out));
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) walk(v, [...keys, k], out);
  }
}

function valueAt(document: Raw, keys: readonly string[]): unknown {
  return keys.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], document);
}

export function mutationsOf(base: Raw): Mutation[] {
  const paths: string[][] = [];
  walk(base, [], paths);
  const out: Mutation[] = [];
  for (const keys of paths) {
    if (keys.length === 0) continue;
    const path = keys.join('.');
    const original = valueAt(base, keys);
    for (const [how, replacement] of REPLACEMENTS) {
      if (JSON.stringify(replacement) === JSON.stringify(original)) continue;
      const document = clone(base);
      parentOf(document, keys)[keys[keys.length - 1]!] = clone(replacement);
      out.push({ path, how: `set:${how}`, document });
    }
    const gone = clone(base);
    const holder = parentOf(gone, keys);
    if (Array.isArray(holder)) holder.splice(Number(keys[keys.length - 1]), 1);
    else delete holder[keys[keys.length - 1]!];
    out.push({ path, how: 'delete', document: gone });
  }
  for (const keys of [[] as string[], ...paths]) {
    const original = keys.length === 0 ? base : valueAt(base, keys);
    if (typeof original !== 'object' || original === null || Array.isArray(original)) continue;
    const document = clone(base);
    const target = keys.length === 0 ? document : (valueAt(document, keys) as Record<string, unknown>);
    target[UNKNOWN_KEY] = 1;
    out.push({ path: keys.join('.') || '(root)', how: 'unknown-key', document });
  }
  return out;
}
