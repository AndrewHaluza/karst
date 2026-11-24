// Base drift for command test gates (unit, integration): tell the ticket's own
// test breaks from develop's. A vitest gate that fails is re-judged by running
// ONLY the failing test files at the ticket's merge base: a test that fails
// there too is DRIFT (notice, not a failure), one that passes there is the
// TICKET'S BREAK. Pure functions only; scripts/vitestGate.mjs does the git work.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

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
 * Whether vitest reported an unhandled rejection/error (its own section, or the
 * `Errors N error(s)` count), which makes the printed ids an incomplete account.
 */
export function hasUnhandledError(output) {
  const text = output.replace(ANSI, '');
  return /^\s*(?:Unhandled )?Errors?\s+\d+/m.test(text) || /Unhandled (?:Rejection|Error)/.test(text);
}

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
  if (hasUnhandledError(text)) return false;
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
 * Split the ids by the alone re-runs. `alone` maps file -> { status, failed: Set of ids that failed again, unhandled? }.
 * A file that passed alone (status 0, no unhandled error) is flaky; otherwise its ids that fail again (all of them when none parse) are breaks.
 */
export function classifyRerun(ids, alone) {
  const flaky = [];
  const breaks = [];
  for (const id of ids) {
    const r = alone.get(fileOfId(id));
    const again = r && (r.unhandled || (r.status !== 0 && (r.failed.size === 0 || r.failed.has(id))));
    (again || !r ? breaks : flaky).push(id);
  }
  return { flaky, breaks };
}

/** The one-line flake notice. */
export const flakeNotice = (ids) => `NOTICE: flaky: ${ids.join('; ')} (passed when re-run alone)`;

/** A path vitest can re-run as a test file: a test/spec module outside node_modules and the node core. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const isTestFile = (path) => !path.startsWith('node:') && !path.includes('node_modules/') && TEST_FILE.test(path);

/** Strip `file://`, make an absolute path inside `cwd` relative to it, and a leading `./`. */
function normalizeFile(path, cwd) {
  let out = path.replace(/^file:\/\//, '');
  if (cwd !== null && out.startsWith('/')) {
    const root = resolve(cwd);
    if (out.startsWith(`${root}/`)) out = out.slice(root.length + 1);
  }
  return out.replace(/^\.\//, '');
}

const FAIL_HEAD = /^\s*FAIL\b/;
const TEST_FILES_HEAD = /^\s*Test Files\s/;
const UNHANDLED_ENTER = /Unhandled (?:Rejection|Errors?)/i;
const SECTION_DIVIDER = /⎯{3,}.*(?:Failed Tests|Failed Suites)/i;
const FRAME = /^\s*(?:at|❯)\s+(.*)$/;
const PAREN_PATH = /\(([^()]+?):\d+(?::\d+)?\)/;
// A bare frame is `path:line[:col]` or Vitest's named form `name path:line[:col]`
// (`❯ leak scripts/a.test.mjs:3:18`): take the test-file path token, never the name.
const BARE_PATH = /(?:^|\s)(\S*\.(?:test|spec)\.[cm]?[jt]sx?):\d+(?::\d+)?$/;

/**
 * The test files a failed vitest run names: the file of every FAIL/× line, plus
 * the test-file stack frames of an unhandled-error section. Deduped, first seen first.
 * Used when the ids are not all parseable, so the flake re-run still gets a target.
 */
export function failingFilesFromOutput(output, cwd = null) {
  const files = [];
  const push = (path) => {
    const file = normalizeFile(path.trim(), cwd);
    if (isTestFile(file) && !files.includes(file)) files.push(file);
  };
  let inUnhandled = false;
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    if (FAIL_HEAD.test(raw) || TEST_FILES_HEAD.test(raw) || SECTION_DIVIDER.test(raw)) inUnhandled = false;
    const m = FAIL_LINE.exec(raw.trim());
    if (m) {
      // `file > suite > test` names its file; a file-level line names it first (`FAIL  src/c.test.ts [ … ]`).
      if (m[1].includes(' > ')) push(fileOfId(m[1]));
      else push(m[1].replace(/^\|[^|]*\|\s*/, '').split(/\s+/)[0] ?? '');
      continue;
    }
    if (UNHANDLED_ENTER.test(raw)) {
      inUnhandled = true;
      continue;
    }
    if (!inUnhandled) continue;
    const frame = FRAME.exec(raw);
    if (frame === null) continue;
    const paren = PAREN_PATH.exec(frame[1]);
    const path = paren ? paren[1] : BARE_PATH.exec(frame[1])?.[1];
    if (path !== undefined) push(path);
  }
  return files;
}

/**
 * The unparseable-output flake re-run plan: the files named in the output, one
 * alone re-run each. A skip carries its printed reason. Never on GitHub Actions,
 * never when a reported failing file could not be read, never above the cap.
 */
export function planUnparseableFlakeRerun(output, { env = {}, cap = FLAKE_FILE_CAP, cwd = null } = {}) {
  if (env.GITHUB_ACTIONS === 'true') return { kind: 'skip', reason: 'flake re-run skipped: GitHub Actions never excuses a failure' };
  // A run with no Test Files summary aborted before it could account for its files, so a
  // partial read is not the full failing set and must never be excused as flaky.
  if (!ranTests(output)) return { kind: 'skip', reason: 'flake re-run skipped: no Test Files summary, so the run did not finish' };
  const files = failingFilesFromOutput(output, cwd);
  if (files.length === 0) return { kind: 'skip', reason: 'flake re-run skipped: no failing test files' };
  const reported = /^\s*Test Files\s+(?:(\d+) failed)?/m.exec(output.replace(ANSI, ''));
  const failed = reported ? Number(reported[1] ?? 0) : null;
  if (failed !== null && files.length < failed) {
    return { kind: 'skip', reason: `flake re-run skipped: only ${files.length} of ${failed} failed test files could be read` };
  }
  if (files.length > cap) return { kind: 'skip', reason: `flake re-run skipped: ${files.length} files fail (cap ${cap}), a real break` };
  return { kind: 'run', files };
}

/** Whether an alone re-run is clean: exit 0, ran the suites, no failed test, no unhandled error. */
export function isCleanRerun({ status, out, hung = false, signaled = false }) {
  return status === 0 && !hung && !signaled && ranTests(out) && failingTestIds(out).length === 0 && allFailuresParsed(out, []);
}

/** Split failing FILES by their alone re-runs: a clean re-run is flaky, everything else is a break. */
export function classifyFileRerun(files, alone) {
  const flaky = [];
  const breaks = [];
  for (const file of files) {
    const r = alone.get(file);
    (r && isCleanRerun(r) ? flaky : breaks).push(file);
  }
  return { flaky, breaks };
}

/** Most entries in the slowest-tests summary. */
export const SLOWEST_CAP = 5;
const TIMED_LINE = /^[✓✔×]\s+(\S.*?)\s+(\d+)ms$/;

/** The slowest timed vitest result lines (`name — Nms`), slowest first; [] when none is timed. */
export function slowestTests(output, cap = SLOWEST_CAP) {
  const seen = new Map();
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    const m = TIMED_LINE.exec(raw.trim());
    if (m) seen.set(m[1], Math.max(seen.get(m[1]) ?? 0, Number(m[2])));
  }
  return [...seen].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([name, ms]) => `${name} — ${ms}ms`);
}

/** The gate-summary lines for the slowest tests; [] when none is timed. */
export const slowestLines = (output, cap = SLOWEST_CAP) => {
  const rows = slowestTests(output, cap);
  return rows.length === 0 ? [] : ['Slowest tests:', ...rows.map((r) => `  ${r}`)];
};
