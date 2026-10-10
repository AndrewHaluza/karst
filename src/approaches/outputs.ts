/**
 * Approach `outputs:` — the repo-relative globs an approach writes artifacts to,
 * each with a kind. Karst never moves or filters these; it only reads the union
 * (`effectiveOutputs`) to know where to look. NOT `artifacts:`: that key is the
 * agent/skill/command inventory on `ApproachPackage`.
 *
 * Pure: no fs, no vscode.
 */

import { ManifestError } from '../manifest/error.js';
import { OUTPUT_KINDS } from '../manifest/types.js';
import type { ApproachDef, Manifest, OutputDef, OutputKind } from '../manifest/types.js';
import { normalizeGraphPath } from './graph/paths.js';

/** An output tagged with the approach that declared (or defaults to) it. */
export interface TaggedOutput extends OutputDef {
  approachId: string;
}

/**
 * Used when an approach declares no outputs. Every path here was verified:
 * the rpi entries come from its fetched commands (`rpi/{feature-slug}/research/RESEARCH.md`
 * and `rpi/{feature-slug}/plan/PLAN.md`).
 */
export const DEFAULT_OUTPUTS: Readonly<Record<string, readonly OutputDef[]>> = {
  superpowers: [
    { glob: 'docs/superpowers/plans/**', kind: 'plan' },
    { glob: 'docs/superpowers/specs/**', kind: 'spec' },
  ],
  speckit: [
    { glob: 'specs/**', kind: 'spec' },
    { glob: '.specify/memory/**', kind: 'meta' },
  ],
  gsd: [{ glob: '.planning/**', kind: 'plan' }],
  rpi: [
    { glob: 'rpi/*/research/**', kind: 'research' },
    { glob: 'rpi/*/plan/**', kind: 'plan' },
  ],
};

const GLOB_CHARS = /[*?[{]/;
const ENTRY_KEYS = new Set(['glob', 'kind']);

function isKind(v: unknown): v is OutputKind {
  return typeof v === 'string' && (OUTPUT_KINDS as readonly string[]).includes(v);
}

/** Fault for a glob, or undefined when it is a safe repo-relative pattern. */
function globFault(glob: string): string | undefined {
  if (glob.startsWith('/') || glob.includes('\\') || /^[a-zA-Z]:/.test(glob)) {
    return 'must be a repo-relative path';
  }
  const segments = glob.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'must not contain empty, "." or ".." segments';
  }
  // The literal prefix (segments before the first glob char) gets the same
  // rejections as graph paths: Windows aliases, reserved names, NFC aliases.
  // Brace alternatives expand into their own path pieces (`{a,..}/x`, `{a/b,c}`),
  // so `..` / `.` / `~` hidden inside one must be refused too, and a brace group
  // may not span a `/` (its pieces would escape the per-segment checks above).
  if (/\{[^}]*\//.test(glob)) return 'must not contain "/" inside a {…} group';
  if (glob.split(/[/{},]/).some((t) => t === '.' || t === '..')) {
    return 'must not contain ".." or "." segments';
  }
  if (segments.some((s) => s.startsWith('~'))) return 'must not start a segment with "~"';
  const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
  const prefix = (firstGlob === -1 ? segments : segments.slice(0, firstGlob)).join('/');
  if (prefix !== '' && !normalizeGraphPath(prefix).ok) {
    return `has an unsafe literal prefix "${prefix}"`;
  }
  return undefined;
}

/** Validate a raw `outputs` value; returns fresh entries. */
export function validateOutputs(raw: unknown, where: string): OutputDef[] {
  if (!Array.isArray(raw)) throw new ManifestError(`${where} must be an array`);
  return raw.map((entry, i) => {
    const at = `${where}[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ManifestError(`${at} must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!ENTRY_KEYS.has(key)) throw new ManifestError(`${at}.${key} is not a known field`);
    }
    if (typeof rec.glob !== 'string' || rec.glob.length === 0) {
      throw new ManifestError(`${at}.glob must be a non-empty string`);
    }
    const fault = globFault(rec.glob);
    if (fault !== undefined) throw new ManifestError(`${at}.glob ${fault}: "${rec.glob}"`);
    if (!isKind(rec.kind)) {
      throw new ManifestError(`${at}.kind must be one of ${OUTPUT_KINDS.join('|')}`);
    }
    return { glob: rec.glob, kind: rec.kind };
  });
}

function outputsOf(approach: ApproachDef): readonly OutputDef[] {
  if (approach.outputs !== undefined && approach.outputs.length > 0) return approach.outputs;
  return DEFAULT_OUTPUTS[approach.id] ?? [];
}

/** Union of outputs across all enabled approaches, in manifest order. */
export function effectiveOutputs(manifest: Manifest): TaggedOutput[] {
  return (manifest.approaches ?? [])
    .filter((a) => a.enabled !== false)
    .flatMap((a) => outputsOf(a).map((o) => ({ approachId: a.id, glob: o.glob, kind: o.kind })));
}
