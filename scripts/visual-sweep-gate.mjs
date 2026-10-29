/**
 * CI gate for the visual sweep (.github/workflows/ci.yml).
 *
 * A red screenshot blocks a PR only when the PR is to blame. Blocking:
 *
 * - A run that executed zero tests. Before NDL-218 the webServer died on
 *   startup (ENOENT webviewSend.webview.js) and `continue-on-error: true` still
 *   recorded conclusion=success, so PRs showed a green job that had never run
 *   a single test.
 * - On a pull request, a baseline the PR ITSELF added or changed, failing its
 *   own screenshot (#769): its new pixels are not the ones CI renders.
 * - On a pull request, a NEW break: a screenshot that fails here but is not in
 *   develop's red set (`visual-red-develop.json`, published by every develop
 *   push run). A PR that shifts shared UI without re-recording the screens it
 *   affected used to land green and let develop drift.
 *
 * Advisory: screenshots already red on develop ("pre-existing on develop"),
 * so a PR is never blamed for inherited drift. When no develop red set is
 * available the rule falls back to the own-baseline rule only, and the summary
 * says so; a missing artifact never fails the job.
 *
 * Reads the `json` reporter's output (tests/visual/.results.json, written by
 * playwright.config.ts) and the baselines changed against the PR's base
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

// Real path, not the import URL's: on macOS a checkout under /tmp (or any
// symlinked directory) would otherwise resolve to /private/tmp here while
// Playwright's report holds the path the process actually ran in, and every
// attachment would look like it lived outside the repo.
const root = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));

/** The JSON reporter's output (playwright.config.ts). */
export const RESULTS_PATH = join(root, 'tests', 'visual', '.results.json');

/** This run's red set; develop push runs upload it as `visual-red-develop.json`. */
export const RED_PATH = join(root, 'tests', 'visual', 'visual-red-develop.json');

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
 * own, and the sweep there stays fully advisory. A `git` failure THROWS — the
 * guard must not silently degrade into the advisory behaviour it exists to
 * replace.
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
    for (const attachment of spec.attachments) {
      if (!attachment.name?.endsWith('-expected.png') || !attachment.path) continue;
      const baseline = repoRelative(attachment.path, rootDir);
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

/** Every failing screenshot of a report (`unexpected` by default): its id, project and diff size. */
export function failingScreenshots(rep, statuses = ['unexpected']) {
  const failing = [];
  for (const spec of projectSpecs(rep, undefined)) {
    if (!statuses.includes(spec.status)) continue;
    if (spec.project === 'layout' || spec.project === 'layout-teardown') continue;
    const message = spec.errors.join('\n').replace(ANSI, '');
    failing.push({
      id: `${spec.file ?? ''}::${spec.title}`,
      project: spec.project ?? '',
      diff: DIFF_LINE.exec(message)?.[1] ?? 'diff size unavailable',
    });
  }
  return failing;
}

/**
 * Tests Playwright never started (no result at all, e.g. the run was cut short
 * by maxFailures or an interrupt). An intentional `testInfo.skip()` still
 * leaves a result, so it does not count.
 */
export function neverRanCount(rep) {
  return [...projectSpecs(rep, undefined)].filter((s) => s.status === 'skipped' && s.resultCount === 0).length;
}

const redKey = (f) => `${f.project}|${f.id}`;

/**
 * Split failures into new breaks and pre-existing ones.
 *
 * `developRed` is develop's `visual-red-develop.json` (array of {id, project})
 * or null when no artifact was available: then nothing is a new break.
 */
export function classifyFailures(failing, developRed) {
  if (!developRed) return { newBreaks: [], preExisting: [], developKnown: false };
  const red = new Set(developRed.map(redKey));
  return {
    newBreaks: failing.filter((f) => !red.has(redKey(f))),
    preExisting: failing.filter((f) => red.has(redKey(f))),
    developKnown: true,
  };
}

/** Markdown for the run summary. */
export function summaryMarkdown({ newBreaks, preExisting, developKnown, owned }) {
  const lines = ['## Visual gate', ''];
  if (!developKnown) {
    lines.push('No develop red set available: only the zero-run and own-baseline rules applied. Other diffs are advisory.', '');
  }
  if (owned.length > 0) lines.push('**Own baselines failing:**', ...owned.map((o) => `- ${o}`), '');
  if (newBreaks.length > 0) {
    lines.push('**New breaks caused by this PR (green on develop):**');
    lines.push(...newBreaks.map((f) => `- \`${f.project}\` ${f.id}: ${f.diff}`), '');
  }
  if (preExisting.length > 0) {
    lines.push('**Pre-existing on develop (advisory):**');
    lines.push(...preExisting.map((f) => `- \`${f.project}\` ${f.id}: ${f.diff}`), '');
  }
  return lines.join('\n');
}

function readDevelopRed() {
  const path = process.env.VISUAL_RED_DEVELOP;
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

  // Layout-sanity gate (ui:LAYOUT-SANITY). Geometry never fails a `layout` test,
  // so `unexpected` there is a harness error; in `layout-teardown` it is the
  // ledger verdict (a new or stale entry, or a seed/prune refusal). Screenshot
  // diffs in the other projects stay advisory.
  const layoutProblems = layoutGateProblems(report);
  if (layoutProblems.length > 0) {
    fail(`visual-sweep-gate: layout gate failed:\n- ${layoutProblems.join('\n- ')}`);
  }

  let changed;
  try {
    changed = prChangedBaselines();
  } catch (err) {
    fail(err.message);
  }

  const owned = baselineProblems(report, changed);
  const failing = failingScreenshots(report);
  // Every run records its red set; the workflow uploads it from develop pushes.
  // Flaky screenshots (failed, then passed on retry) are unstable, not a clean
  // baseline: record them as red so a flake on develop never blames a PR.
  // A partial sweep (tests that never started) would leave those tests out of
  // the red set and blame the next PR for them, so it publishes nothing.
  const unstable = failingScreenshots(report, ['unexpected', 'flaky']);
  const notStarted = neverRanCount(report);
  if (notStarted === 0) {
    writeFileSync(RED_PATH, JSON.stringify(unstable.map(({ id, project }) => ({ id, project }))));
  } else {
    console.warn(`visual-sweep-gate: ${notStarted} test(s) never started; not publishing a red set.`);
  }

  const isPr = process.env.GITHUB_EVENT_NAME === 'pull_request';
  const { newBreaks, preExisting, developKnown } = classifyFailures(failing, isPr ? readDevelopRed() : null);
  const summary = summaryMarkdown({ newBreaks, preExisting, developKnown, owned });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  if (owned.length > 0) {
    fail(
      'visual-sweep-gate: this pull request added or changed a baseline that does not match its own ' +
        `screenshot (record baselines in the pinned image: npm run -s test:visual:docker:update):\n- ${owned.join('\n- ')}`,
    );
  }
  if (newBreaks.length > 0) {
    fail(
      'visual-sweep-gate: this pull request breaks screenshots that are green on develop ' +
        `(re-record them with npm run -s test:visual:docker:update, or fix the regression):\n- ${newBreaks
          .map((f) => `${f.project} ${f.id}: ${f.diff}`)
          .join('\n- ')}`,
    );
  }

  console.log(
    `visual-sweep-gate: ${ran} test(s) executed ` +
      `(expected=${stats.expected ?? 0}, unexpected=${stats.unexpected ?? 0}, ` +
      `flaky=${stats.flaky ?? 0}, skipped=${stats.skipped ?? 0}). ` +
      `Own-baseline failures: ${owned.length}; new breaks: ${newBreaks.length}; ` +
      `pre-existing on develop: ${preExisting.length}${developKnown ? '' : ' (no develop red set; advisory)'}.`,
  );
}

if (process.argv[1] && process.argv[1].endsWith('visual-sweep-gate.mjs')) {
  main();
}
