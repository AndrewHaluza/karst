// Base drift for command test gates (unit, integration): tell the ticket's own
// test breaks from develop's. A vitest gate that fails is re-judged by running
// ONLY the failing test files at the ticket's merge base: a test that fails
// there too is DRIFT (notice, not a failure), one that passes there is the
// TICKET'S BREAK. Pure functions only; scripts/vitestGate.mjs does the git work.

import { createHash } from 'node:crypto';

const DEP_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

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

/**
 * Whether the parsed ids cover EVERY failure vitest reported (summary counts, no
 * file-level or unhandled errors). If not, a drift verdict on the ids must not pass the gate.
 */
export function allFailuresParsed(output, ids) {
  const text = output.replace(ANSI, '');
  const count = (label) => {
    const m = new RegExp(`^\\s*${label}\\s+(?:(\\d+) failed)?`, 'm').exec(text);
    return m ? Number(m[1] ?? 0) : null;
  };
  const tests = count('Tests');
  const files = count('Test Files');
  if (tests === null || files === null) return false;
  if (/^\s*(?:Unhandled )?Errors?\s+\d+/m.test(text) || /Unhandled (?:Rejection|Error)/.test(text)) return false;
  return tests === ids.length && files <= new Set(ids.map(fileOfId)).size;
}

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
  const deps = [...touched].filter((f) => DEP_FILES.has(f.split('/').pop()));
  if (deps.length > 0) return { kind: 'fail', reason: `the ticket changed dependency files (${deps.join(', ')}); the base re-run reuses this checkout's node_modules, so it cannot judge` };
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

/** Most failing test files re-run alone for the flake check; above it the failure is a real break. */
export const FLAKE_FILE_CAP = 3;

/** Whether the remaining failing ids may be re-run file by file; a skip carries its printed reason. */
export function planFlakeRerun(ids, cap = FLAKE_FILE_CAP) {
  const files = [...new Set(ids.map(fileOfId))];
  if (files.length === 0) return { kind: 'skip', reason: 'flake re-run skipped: no failing test files' };
  if (files.length > cap) return { kind: 'skip', reason: `flake re-run skipped: ${files.length} files fail (cap ${cap}), a real break` };
  return { kind: 'run', files };
}

/**
 * Split the ids by the alone re-runs. `alone` maps file -> { status, failed: Set of ids that failed again }.
 * A file that passed alone (status 0) is flaky; otherwise its ids that fail again (all of them when none parse) are breaks.
 */
export function classifyRerun(ids, alone) {
  const flaky = [];
  const breaks = [];
  for (const id of ids) {
    const r = alone.get(fileOfId(id));
    const again = r && r.status !== 0 && (r.failed.size === 0 || r.failed.has(id));
    (again || !r ? breaks : flaky).push(id);
  }
  return { flaky, breaks };
}

/** The one-line flake notice. */
export const flakeNotice = (ids) => `NOTICE: flaky: ${ids.join('; ')} (passed when re-run alone)`;
