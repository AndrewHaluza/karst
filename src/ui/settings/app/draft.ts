/**
 * Pure draft arithmetic for the settings React app (NDL-126 §3 state boundary).
 *
 * These are the functions the vanilla inline script carried as
 * `overlaySections` / `deepEqual` / `dirtySectionsOf` / `sectionsToKeep`. They
 * are moved here rather than rewritten: the reducer has to compute the same
 * answers, and a port that recomputed them differently would show dirty markers
 * the vanilla view does not (the bug the `deepEqual` order-insensitivity comment
 * documents). No React, no DOM, no `vscode` — `reducer.test.ts` covers them in a
 * plain node environment.
 *
 * R-X1 (import, never mirror): `SECTION_FIELDS` / `SETTINGS_SECTIONS` are
 * imported from `../sections.js` rather than restated here.
 */
import type { Manifest } from '../../../manifest/types.js';
import {
  SECTION_FIELDS,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from '../sections.js';

/** A deep, plain-JSON copy. Mirrors the script's `clone`. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Order-INSENSITIVE deep equality, with ordered arrays.
 *
 * The comparison was `JSON.stringify`-based once, which made it key-order
 * sensitive — and the manifest validator re-emits every nested block in its own
 * canonical key order, while a tab editor appends a newly-set key at the end of
 * the block it spread. A tab whose edit added a previously-absent nested key
 * then never matched the file again after Save and stayed dirty forever. Values
 * decide, not the order the file happens to serialize them in.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, i) => deepEqual(entry, b[i])); // arrays ARE ordered
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Whether `section`'s claimed fields are equal in both manifests. */
export function sectionFieldsEqual(
  a: Manifest,
  b: Manifest,
  section: SettingsSection,
): boolean {
  for (const field of SECTION_FIELDS[section]) {
    const hasA = Object.prototype.hasOwnProperty.call(a, field);
    const hasB = Object.prototype.hasOwnProperty.call(b, field);
    if (hasA !== hasB) return false;
    if (hasA && !deepEqual(a[field], b[field])) return false;
  }
  return true;
}

/**
 * `base` with each named section's fields taken from `source`. A field absent
 * from `source` is REMOVED, exactly as the host's `mergeSection` does it — that
 * is how an optional template gets cleared.
 */
export function overlaySections(
  base: Manifest,
  source: Manifest,
  sections: readonly SettingsSection[],
): Manifest {
  const merged = { ...(base as unknown as Record<string, unknown>) };
  const from = source as unknown as Record<string, unknown>;
  for (const section of sections) {
    for (const field of SECTION_FIELDS[section]) {
      if (Object.prototype.hasOwnProperty.call(from, field)) merged[field] = from[field];
      else delete merged[field];
    }
  }
  return merged as unknown as Manifest;
}

/** Which tabs the draft has uncommitted edits on, in nav order. */
export function dirtySectionsOf(
  draftManifest: Manifest,
  baseManifest: Manifest,
): readonly SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => !sectionFieldsEqual(draftManifest, baseManifest, s));
}

/**
 * Which tabs' drafts survive an incoming `state` push.
 *
 * Every dirty tab is kept — a push arrives after each out-of-band write (agent
 * toggle, approach install) and replacing the whole draft would silently throw
 * away edits parked elsewhere — EXCEPT the section a Save is currently writing.
 * For that one the file is authoritative: its edits were just committed, and the
 * validator re-emits the block with its own key order and default keys filled
 * in, which a raw draft never equals again. Keeping it was what left a saved tab
 * showing unsaved changes forever.
 */
export function sectionsToKeep(
  draftManifest: Manifest,
  baseManifest: Manifest,
  savedSection: SettingsSection | null,
): readonly SettingsSection[] {
  return dirtySectionsOf(draftManifest, baseManifest).filter((s) => s !== savedSection);
}