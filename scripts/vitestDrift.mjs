// Base drift for command test gates (unit, integration): tell the ticket's own
// test breaks from develop's. A vitest gate that fails is re-judged by running
// ONLY the failing test files at the ticket's merge base: a test that fails
// there too is DRIFT (notice, not a failure), one that passes there is the
// TICKET'S BREAK. Pure functions only; scripts/vitestGate.mjs does the git work.

import { createHash } from 'node:crypto';

/** Most failing test files re-run at the base; above it the base is judged broken wholesale. */
export const BASE_FILE_CAP = 15;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const FAIL_LINE = /^(?:FAIL|×)\s+(\S.*?)(?:\s+\d+ms)?$/;

/** Deduped `<file> > <suite> > <test>` ids of the vitest FAIL lines of a gate's output. */
export function failingTestIds(output) {
  const ids = [];
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    const m = FAIL_LINE.exec(raw.trim());
    if (m && m[1].includes(' > ') && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** Whether vitest actually ran test files (printed its summary); a base run that did not says nothing about the tests. */
export const ranTests = (output) => /^\s*Test Files\s.*\b(?:passed|failed)\b/m.test(output.replace(ANSI, ''));

/** The test file of an id (project prefixes like `|unit|` are dropped). */
export const fileOfId = (id) => id.split(' > ')[0].replace(/^\|[^|]*\|\s*/, '').trim();

/** Stable cache key for one base verdict: (repo, base sha, test id). */
export function cacheKey(repo, sha, id) {
  return createHash('sha256').update([repo, sha, id].join('\0')).digest('hex').slice(0, 32);
}

/**
 * Whether a failed gate can be re-judged against the base.
 * `touched` are the paths the ticket changed (a test file it touched is never drift).
 */
export function planBaseCheck(ids, touched, cap = BASE_FILE_CAP) {
  if (ids.length === 0) return { kind: 'skip', reason: 'no parseable failing test ids' };
  const files = [...new Set(ids.map(fileOfId))];
  const own = files.filter((f) => touched.has(f));
  if (own.length > 0) return { kind: 'fail', reason: `the ticket changed failing test file(s), never drift: ${own.join(', ')}` };
  if (files.length > cap) {
    return { kind: 'fail', reason: `${files.length} test files fail (cap ${cap}): base likely broken wholesale, so no per-test base check` };
  }
  return { kind: 'run', files };
}

/** Split the ticket's failing ids by the base verdict (`redAtBase`: a Set of ids): red there = drift, else the ticket's break. */
export function classifyFailures(ids, redAtBase) {
  const drift = [];
  const breaks = [];
  for (const id of ids) (redAtBase.has(id) ? drift : breaks).push(id);
  return { drift, breaks };
}

/** The one-line ticket notice. */
export const driftNotice = (ids) => `NOTICE: develop is red: ${ids.join('; ')}`;

/** The gate-output lines for a classification. */
export function reportLines({ drift, breaks }) {
  const lines = [];
  if (drift.length > 0) lines.push(`base drift (develop drift, not this ticket) — ${drift.length}:`, ...drift.map((i) => `  - ${i}`), driftNotice(drift));
  if (breaks.length > 0) lines.push(`ticket breaks (pass at the base, fail here) — ${breaks.length}:`, ...breaks.map((i) => `  - ${i}`));
  return lines;
}

/** The one project-level alert line, deduped by the caller per base sha. */
export const alertLine = (sha, ids) => `KARST-ALERT: develop-red base=${sha} tests=${ids.join('; ')}`;
