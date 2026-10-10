/**
 * Install-time scan of an approach's prompt bodies for repo-relative output
 * locations ("save to docs/x/plans/…"). Produces SUGGESTIONS only: the caller
 * stores them as pending on the package, and nothing reaches karst.yml until the
 * user accepts them in Settings. Heuristic and best-effort by design.
 *
 * Pure: no fs, no vscode.
 */

import type { OutputDef, OutputKind } from '../manifest/types.js';
import { validateOutputs } from './outputs.js';

/** Upper bound on suggestions kept per package; a noisy body must not flood Settings. */
const MAX_SUGGESTIONS = 12;

const WRITE_VERB =
  /\b(save|saves|saved|write|writes|written|create|creates|created|output|outputs|store|stores|generate|generates|append|appends|emit|emits)\b/i;

/** Segments that are tooling or VCS state, never an approach's deliverable. */
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git', '.claude', '.github', '.karst']);

const PLACEHOLDERS: readonly RegExp[] = [
  /<[^>]*>/g,
  /\{[^}]*\}/g,
  /\[[^\]]*\]/g,
  /\$\{?\w+\}?/g,
  /YYYY-MM-DD/g,
];

const SAFE_SEGMENT = /^[\w.*-]+$/;
const FILE_EXT = /\.[A-Za-z0-9]{1,5}$/;

const KIND_WORDS: ReadonlyArray<readonly [RegExp, OutputKind]> = [
  [/memory|meta/, 'meta'], // before spec: `.specify/` contains "spec"
  [/research/, 'research'],
  [/review/, 'review'],
  [/spec/, 'spec'],
  [/plan/, 'plan'],
  [/script/, 'script'],
];

function guessKind(glob: string): OutputKind {
  const lower = glob.toLowerCase();
  return KIND_WORDS.find(([re]) => re.test(lower))?.[1] ?? 'other';
}

function candidateTokens(line: string): string[] {
  return line
    .split(/[\s`'"(),;]+/)
    .map((t) => t.replace(/[.:]+$/, ''))
    .filter((t) => t.includes('/'));
}

function isRepoRelative(token: string): boolean {
  return !(
    token.includes('://') ||
    token.startsWith('/') ||
    token.startsWith('~') ||
    token.startsWith('$') ||
    token.startsWith('..') ||
    token.startsWith('./')
  );
}

/** Directory glob for a path-like token, or null when it is not a usable output dir. */
function toGlob(token: string): string | null {
  if (!isRepoRelative(token)) return null;
  const normalized = PLACEHOLDERS.reduce((acc, re) => acc.replace(re, '*'), token);
  const segments = normalized.split('/');
  const trailingSlash = segments[segments.length - 1] === '';
  const parts = segments.filter((s) => s !== '');
  const last = parts[parts.length - 1];
  const dirs = !trailingSlash && last !== undefined && FILE_EXT.test(last) ? parts.slice(0, -1) : parts;
  if (dirs.length === 0) return null;
  if (dirs.some((s) => EXCLUDED_SEGMENTS.has(s) || !SAFE_SEGMENT.test(s))) return null;
  return `${dirs.join('/')}/**`;
}

function isValid(entry: OutputDef): boolean {
  try {
    validateOutputs([entry], 'suggestion');
    return true;
  } catch {
    return false;
  }
}

/** Output-location suggestions found across `bodies`, deduped, first-seen order. */
export function scanOutputSuggestions(bodies: readonly string[]): OutputDef[] {
  const seen = new Set<string>();
  const found: OutputDef[] = [];
  for (const body of bodies) {
    for (const line of body.split('\n')) {
      if (!WRITE_VERB.test(line)) continue;
      for (const token of candidateTokens(line)) {
        const glob = toGlob(token);
        if (glob === null || seen.has(glob)) continue;
        const entry: OutputDef = { glob, kind: guessKind(glob) };
        if (!isValid(entry)) continue;
        seen.add(glob);
        found.push(entry);
      }
    }
  }
  return found.slice(0, MAX_SUGGESTIONS);
}
