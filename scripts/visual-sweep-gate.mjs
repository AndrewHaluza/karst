/**
 * CI gate for the visual sweep (.github/workflows/ci.yml).
 *
 * Blocking, on a pull request and on a push to develop alike:
 *
 * - A run that executed zero tests. Before NDL-218 the webServer died on
 *   startup (ENOENT webviewSend.webview.js) and `continue-on-error: true` still
 *   recorded conclusion=success, so PRs showed a green job that had never run
 *   a single test.
 * - On a pull request, a baseline the PR ITSELF added or changed, failing its
 *   own screenshot (#769): its new pixels are not the ones CI renders.
 * - A red screenshot that the committed ledger
 *   (tests/visual/visual-known-failures.json, scripts/visualLedger.mjs) does
 *   not list. The ledger replaced develop's advisory red set: a screenshot red
 *   on develop used to stay exempt for good, because nothing made it shrink.
 * - On a full run only, a STALE ledger entry: its test passes, or no longer
 *   exists. A scoped run cannot tell, so it judges no entry stale.
 *   `KARST_VISUAL_PRUNE=1` removes the stale entries, and refuses on a partial
 *   or non-authoritative run (npm run -s test:visual:docker:prune).
 * - On a pull request, a ledger entry that the PR adds: the ledger only shrinks.
 *
 * A flaky screenshot (failed, then passed on retry) blocks nothing; the summary
 * names it.
 *
 * - In the sharded CI sweep, a test of the full listing (`VISUAL_LISTED_REPORT`)
 *   that the merged report does not hold: a shard that did not report must
 *   never pass as a smaller sweep.
 *
 * Reads the `json` reporter's output (tests/visual/.results.json, written by
 * playwright.config.ts, or by `merge-reports` over the shard blobs in CI) and the baselines changed against the PR's base
 * commit (`git diff HEAD^1 HEAD`: actions/checkout checks out the merge commit,
 * so its first parent is the base tip; the visual job fetches depth 2).
 *
 * `stats.skipped` is deliberately NOT counted as "ran": Playwright computes a
 * test's outcome as `skipped` when it has no results at all (see
 * computeTestCaseOutcome), so a crash between report-begin and the first
 * executed test would otherwise look like a full run of skipped tests.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_REL, judgeLedger, ledgerGrowth, ledgerKey, parseLedger, pruneLedger, readLedger, serializeLedger } from './visualLedger.mjs';

// Real path, not the import URL's: on macOS a checkout under /tmp (or any
// symlinked directory) would otherwise resolve to /private/tmp here while
// Playwright's report holds the path the process actually ran in, and every
// attachment would look like it lived outside the repo.
const root = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));

/** The JSON reporter's output (playwright.config.ts). */
export const RESULTS_PATH = join(root, 'tests', 'visual', '.results.json');

/** The committed visual ledger (scripts/visualLedger.mjs). */
export const LEDGER_PATH = join(root, LEDGER_REL);

/** The one directory baselines live in (playwright.config.ts `snapshotPathTemplate`). */
export const BASELINES_DIR = 'tests/visual/__baselines__';

/**
 * The repo-relative baselines in a `git diff --name-only` listing.
 *
 * `git` prints posix separators on every platform; nothing else in the listing
 * is a baseline, so everything else is dropped rather than passed through.
 */
export function changedBaselines(diffOutput) {
  const files = new Set();
  for (const raw of diffOutput.split('\n')) {
    const file = raw.trim();
    if (file.startsWith(`${BASELINES_DIR}/`)) files.add(file);
  }
  return files;
}

/** A path from the Playwright report as the repo-relative posix path `git` prints. */
export function repoRelative(path, rootDir = root) {
  const relativePath = isAbsolute(path) ? relative(rootDir, path) : path;
  return relativePath.split('\\').join('/');
}

/**
 * The baselines this pull request added or changed.
 *
 * Empty on every other event: a push to develop owns no baseline diff of its
 * own. A `git` failure THROWS — the guard must not silently degrade into an
 * advisory rule.
 */
export function prChangedBaselines({ env = process.env, gitRun = runGit } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return new Set();
  // HEAD is the PR's merge commit, so HEAD^1 is the base tip and the two-dot
  // diff is exactly the PR's own change (no merge-base walk, no shallow-clone
  // problem). `--diff-filter=ACMR` drops deletions: a baseline the PR removed
  // cannot be compared against anything.
  const result = gitRun(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD^1', 'HEAD', '--', BASELINES_DIR]);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
    throw new Error(
      `visual-sweep-gate: cannot diff the PR's baselines against its base (HEAD^1): ${detail}. ` +
        `Repo root ${root} (cwd ${process.cwd()}). ` +
        'The visual job must check out the pull request merge commit with fetch-depth 2.',
    );
  }
  return changedBaselines(result.stdout ?? '');
}

/**
 * The `git` argv for a diff run, with the repository this gate lives in marked
 * safe.
 *
 * The visual job runs inside a container whose image defaults to a non-root
 * user, while `actions/checkout` writes the checkout as root and records
 * `safe.directory` only in a THROWAWAY HOME (the checkout log's "Temporarily
 * overriding HOME"). Every later step therefore meets git's dubious-ownership
 * guard, which denies the repository and makes `git diff` fall back to its
 * `--no-index` path ("warning: Not a git repository"). Trust exactly `root` —
 * never `*` — so the guard cannot be disarmed by the environment.
 */
export function gitArgs(repoRoot, args) {
  return ['-c', `safe.directory=${repoRoot}`, ...args];
}

/**
 * The ledger at the PR's base tip (HEAD^1), to find the entries the PR adds.
 * Null on every other event, and when the base has no ledger yet. A `git`
 * failure THROWS, as in prChangedBaselines.
 */
export function prLedgerBase({ env = process.env, gitRun = runGit } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return null;
  const gitOrThrow = (args) => {
    const result = gitRun(args);
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
      throw new Error(`visual-sweep-gate: cannot read ${LEDGER_REL} at the PR's base (HEAD^1): ${detail}`);
    }
    return result.stdout ?? '';
  };
  if (gitOrThrow(['ls-tree', '--name-only', 'HEAD^1', '--', LEDGER_REL]).trim() === '') return null;
  return parseLedger(gitOrThrow(['show', `HEAD^1:${LEDGER_REL}`]), `HEAD^1:${LEDGER_REL}`);
}

function runGit(args) {
  return spawnSync('git', gitArgs(root, args), { cwd: root, encoding: 'utf8' });
}

/** Every spec of a Playwright JSON report, with the project its results ran in. */
function* projectSpecs(node, project) {
  for (const spec of node.specs ?? []) {
    for (const t of spec.tests ?? []) {
      yield {
        project: t.projectName ?? project,
        status: t.status,
        title: spec.title,
        file: spec.file,
        resultCount: (t.results ?? []).length,
        errors: (t.results ?? []).map((result) => result.error?.message ?? ''),
        attachments: (t.results ?? []).flatMap((result) => result.attachments ?? []),
      };
    }
  }
  for (const child of node.suites ?? []) yield* projectSpecs(child, project);
}

export function layoutGateProblems(rep) {
  const specs = [...projectSpecs(rep, undefined)];
  const ranIn = (name) => specs.filter((s) => s.project === name && s.status !== 'skipped');
  const problems = [];
  if (ranIn('layout').length === 0) problems.push('project `layout` ran zero tests');
  const teardown = ranIn('layout-teardown');
  if (teardown.length !== 1) problems.push(`project \`layout-teardown\` ran ${teardown.length} test(s), expected exactly 1`);
  for (const s of specs) {
    if ((s.project === 'layout' || s.project === 'layout-teardown') && s.status === 'unexpected') {
      problems.push(`${s.project}: "${s.title}" failed (see the grouped layout output above)`);
    }
  }
  return problems;
}

const SNAPSHOT_LINE = /^\s*Snapshot: (.+?)\s*$/gm;

/**
 * The repo-relative baselines that a failed test compared against.
 *
 * A single run attaches the baseline file itself as `<snapshot>-expected.png`.
 * A report that `merge-reports` wrote (the sharded CI sweep) moves every
 * attachment into the blob's `resources/`, and Playwright trims a long
 * attachment name. The `Snapshot: <name>` line of the error keeps the full
 * name, and `snapshotPathTemplate` puts it at `{projectName}/{arg}{ext}`.
 */
function comparedBaselines(spec, rootDir) {
  const baselines = new Set();
  for (const attachment of spec.attachments) {
    if (!attachment.name?.endsWith('-expected.png') || !attachment.path) continue;
    const path = repoRelative(attachment.path, rootDir);
    if (path.startsWith(`${BASELINES_DIR}/`)) baselines.add(path);
  }
  for (const message of spec.errors) {
    for (const match of message.replace(ANSI, '').matchAll(SNAPSHOT_LINE)) {
      baselines.add(`${BASELINES_DIR}/${spec.project}/${match[1]}`);
    }
  }
  return baselines;
}

/**
 * The tests of the full sweep listing (`playwright test --list --reporter=json`)
 * that the merged report does not hold, as `<project> <file>::<title>`.
 * A shard that did not run, or a shard plan that drops a project, shows here.
 */
export function missingTests(listed, merged) {
  const key = (s) => `${s.project ?? ''} ${s.file ?? ''}::${s.title}`;
  const reported = new Set([...projectSpecs(merged, undefined)].map(key));
  return [...projectSpecs(listed, undefined)].map(key).filter((k) => !reported.has(k));
}

/**
 * The failures this PR owns: a red screenshot whose EXPECTED image is one of
 * the baselines the PR added or changed. The report attaches the compared
 * baseline as `<snapshot>-expected.png`, so the mapping needs no title parsing
 * and no import of the TypeScript variants registry.
 */
export function baselineProblems(rep, changed, rootDir = root) {
  const problems = [];
  for (const spec of projectSpecs(rep, undefined)) {
    if (spec.status !== 'unexpected') continue;
    for (const baseline of comparedBaselines(spec, rootDir)) {
      if (!changed.has(baseline)) continue;
      problems.push(
        `${spec.project}: "${spec.title}" failed against ${baseline}, ` +
          'a baseline this PR added or changed',
      );
    }
  }
  return problems;
}

const ANSI = /\u001b\[[0-9;]*m/g;
const DIFF_LINE = /(\d+ pixels? \(ratio [\d.]+[^)]*\) are different|Expected an image [^\n]+)/;

const isLayoutProject = (project) => project === 'layout' || project === 'layout-teardown';

/** Every failing screenshot of a report (`unexpected` by default): its ledger key, id, project and diff size. */
export function failingScreenshots(rep, statuses = ['unexpected']) {
  const failing = [];
  for (const spec of projectSpecs(rep, undefined)) {
    if (!statuses.includes(spec.status)) continue;
    if (isLayoutProject(spec.project)) continue;
    const message = spec.errors.join('\n').replace(ANSI, '');
    failing.push({
      key: ledgerKey(spec),
      id: `${spec.file ?? ''}::${spec.title}`,
      project: spec.project ?? '',
      diff: DIFF_LINE.exec(message)?.[1] ?? 'diff size unavailable',
    });
  }
  return failing;
}

/**
 * The outcome of every screenshot test of a report, by ledger key (the layout projects have their own ledger).
 * A key seen twice (a merged report, or one leaf title under two describe blocks) keeps `unexpected`: a later
 * pass must never hide a failure.
 */
export function screenshotStatuses(rep) {
  const statuses = new Map();
  for (const spec of projectSpecs(rep, undefined)) {
    if (isLayoutProject(spec.project)) continue;
    const key = ledgerKey(spec);
    if (statuses.get(key) !== 'unexpected') statuses.set(key, spec.status);
  }
  return statuses;
}

/**
 * Tests Playwright never started (no result at all, e.g. the run was cut short
 * by maxFailures or an interrupt). An intentional `testInfo.skip()` still
 * leaves a result, so it does not count.
 */
export function neverRanCount(rep) {
  return [...projectSpecs(rep, undefined)].filter((s) => s.status === 'skipped' && s.resultCount === 0).length;
}

/**
 * True when the report holds the whole sweep: the CI listing is given
 * (`VISUAL_LISTED_REPORT`), no listed test is missing, and every test started.
 * Only a full run judges stale entries or prunes the ledger.
 */
export function isFullRun({ listed, missing, neverRan }) {
  return listed && missing === 0 && neverRan === 0;
}

const failureLine = (f) => `- \`${f.project}\` ${f.id}: ${f.diff}`;

/** Markdown for the run summary. */
export function summaryMarkdown({ unexpected, known, stale, flaky, grown, owned, fullRun }) {
  const lines = ['## Visual gate', ''];
  if (!fullRun) lines.push('Partial run: stale ledger entries were not judged.', '');
  if (owned.length > 0) lines.push('**Own baselines failing:**', ...owned.map((o) => `- ${o}`), '');
  if (unexpected.length > 0) lines.push('**Failures the ledger does not list:**', ...unexpected.map(failureLine), '');
  if (stale.length > 0) lines.push('**Stale ledger entries (they pass now; prune them):**', ...stale.map((k) => `- ${k}`), '');
  if (grown.length > 0) lines.push('**Ledger entries this PR adds (the ledger only shrinks):**', ...grown.map((k) => `- ${k}`), '');
  if (known.length > 0) lines.push(`**Known failures (listed in ${LEDGER_REL}):**`, ...known.map(failureLine), '');
  if (flaky.length > 0) lines.push('**Flaky (passed on retry; not blocking):**', ...flaky.map((k) => `- ${k}`), '');
  return lines.join('\n');
}

const MISSING_SHOWN = 20;

/** `VISUAL_LISTED_REPORT` (sharded CI only): the full listing. Unset: a single run, nothing to compare. */
function missingFromListing(report) {
  const path = process.env.VISUAL_LISTED_REPORT;
  if (!path) return [];
  let listed;
  try {
    listed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`visual-sweep-gate: cannot read the sweep listing ${path}: ${err.message}`);
  }
  return missingTests(listed, report);
}

function fail(message) {
  const annotation = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
  console.error(`${annotation}${message}`);
  process.exit(1);
}

function main() {
  if (!existsSync(RESULTS_PATH)) {
    fail(
      'visual-sweep-gate: no tests/visual/.results.json — Playwright never reached its reporters, so the sweep did not run (webServer/startup crash?).',
    );
  }

  let report;
  try {
    report = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
  } catch (err) {
    fail(`visual-sweep-gate: tests/visual/.results.json is not valid JSON: ${err.message}`);
  }

  const stats = report.stats ?? {};
  const ran = (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0);

  if (ran <= 0) {
    fail(`visual-sweep-gate: the sweep executed 0 tests (stats: ${JSON.stringify(stats)}).`);
  }

  const missing = missingFromListing(report);
  if (missing.length > 0) {
    fail(
      `visual-sweep-gate: ${missing.length} test(s) of the full sweep are not in the merged report ` +
        `(a shard did not report, or the shard plan drops a project):\n- ${missing.slice(0, MISSING_SHOWN).join('\n- ')}`,
    );
  }

  // Layout-sanity gate (ui:LAYOUT-SANITY). Geometry never fails a `layout` test,
  // so `unexpected` there is a harness error; in `layout-teardown` it is the
  // ledger verdict (a new or stale entry, or a seed/prune refusal). Screenshot
  // diffs in the other projects go to the visual ledger below.
  const layoutProblems = layoutGateProblems(report);
  if (layoutProblems.length > 0) {
    fail(`visual-sweep-gate: layout gate failed:\n- ${layoutProblems.join('\n- ')}`);
  }

  let changed;
  let baseLedger;
  try {
    changed = prChangedBaselines();
    baseLedger = prLedgerBase();
  } catch (err) {
    fail(err.message);
  }

  const owned = baselineProblems(report, changed);
  const fullRun = isFullRun({ listed: Boolean(process.env.VISUAL_LISTED_REPORT), missing: missing.length, neverRan: neverRanCount(report) });
  const statuses = screenshotStatuses(report);
  const ledger = currentLedger(statuses, fullRun);
  const verdict = judgeLedger({ statuses, ledger, fullRun });
  const byKey = new Map(failingScreenshots(report).map((f) => [f.key, f]));
  const unexpected = verdict.unexpected.map((key) => byKey.get(key));
  const known = verdict.known.map((key) => byKey.get(key));
  const grown = ledgerGrowth(baseLedger, ledger);
  const summary = summaryMarkdown({ unexpected, known, stale: verdict.stale, flaky: verdict.flaky, grown, owned, fullRun });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  if (owned.length > 0) {
    fail(
      'visual-sweep-gate: this pull request added or changed a baseline that does not match its own ' +
        `screenshot (record baselines in the pinned image: npm run -s test:visual:docker:update):\n- ${owned.join('\n- ')}`,
    );
  }
  const problems = ledgerProblems({ unexpected, stale: verdict.stale, grown });
  if (problems.length > 0) fail(`visual-sweep-gate: ${problems.join('\n\n')}`);

  console.log(
    `visual-sweep-gate: ${ran} test(s) executed ` +
      `(expected=${stats.expected ?? 0}, unexpected=${stats.unexpected ?? 0}, ` +
      `flaky=${stats.flaky ?? 0}, skipped=${stats.skipped ?? 0}). ` +
      `Own-baseline failures: ${owned.length}; known (ledgered) failures: ${known.length}; ` +
      `flaky: ${verdict.flaky.length}${fullRun ? '' : '; partial run, stale entries not judged'}.`,
  );
}

/** The committed ledger, pruned first when `KARST_VISUAL_PRUNE=1` (full authoritative runs only). */
function currentLedger(statuses, fullRun) {
  let ledger;
  try {
    ledger = readLedger(LEDGER_PATH);
    if (process.env.KARST_VISUAL_PRUNE !== '1') return ledger;
    const guard = { authoritative: process.env.KARST_VISUAL_AUTHORITATIVE === '1', fullRun };
    const kept = pruneLedger({ statuses, ledger, guard });
    writeFileSync(LEDGER_PATH, serializeLedger(kept));
    console.log(`visual ledger pruned: ${ledger.length - kept.length} stale entr(ies) removed`);
    return kept;
  } catch (err) {
    fail(`visual-sweep-gate: ${err.message}`);
  }
}

/** The blocking ledger verdicts, one message each. */
function ledgerProblems({ unexpected, stale, grown }) {
  const problems = [];
  if (unexpected.length > 0) {
    problems.push(
      `${unexpected.length} screenshot(s) fail that ${LEDGER_REL} does not list ` +
        `(fix the regression, or re-record with npm run -s test:visual:docker:update):\n- ${unexpected
          .map((f) => `${f.project} ${f.id}: ${f.diff}`)
          .join('\n- ')}`,
    );
  }
  if (stale.length > 0) {
    problems.push(
      `${stale.length} STALE ledger entr(ies) no longer fail — run npm run -s test:visual:docker:prune:\n- ${stale.join('\n- ')}`,
    );
  }
  if (grown.length > 0) {
    problems.push(
      `this pull request adds ${grown.length} entr(ies) to ${LEDGER_REL}; the ledger only shrinks ` +
        `(fix or re-record the screenshot instead):\n- ${grown.join('\n- ')}`,
    );
  }
  return problems;
}

if (process.argv[1] && process.argv[1].endsWith('visual-sweep-gate.mjs')) {
  main();
}
