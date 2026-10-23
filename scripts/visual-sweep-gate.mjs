/**
 * CI gate for the advisory visual sweep (.github/workflows/ci.yml).
 *
 * The sweep step is advisory for screenshot DIFFS: the suite is still
 * settling, so a red baseline must not block a PR.  Two things are NOT
 * advisory:
 *
 * - A run that executed zero tests. Before NDL-218 the webServer died on
 *   startup (ENOENT webviewSend.webview.js) and `continue-on-error: true` still
 *   recorded conclusion=success, so PRs showed a green job that had never run
 *   a single test.
 * - On a pull request, a baseline the PR ITSELF added or changed, failing its
 *   own screenshot (#769). That is the PR telling us its new pixels are not
 *   the ones CI renders; letting it land is how 9 sandbox-recorded baselines
 *   from #722 arrived on develop and stayed red. Pre-existing failures, whose
 *   baseline this PR does not touch, stay advisory.
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
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
        `Repo root ${root} (cwd ${process.cwd()}, .git ${existsSync(join(root, '.git')) ? 'present' : 'MISSING'}). ` +
        'The visual job must check out the pull request merge commit with fetch-depth 2.',
    );
  }
  return changedBaselines(result.stdout ?? '');
}

function runGit(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** Every spec of a Playwright JSON report, with the project its results ran in. */
function* projectSpecs(node, project) {
  for (const spec of node.specs ?? []) {
    for (const t of spec.tests ?? []) {
      yield {
        project: t.projectName ?? project,
        status: t.status,
        title: spec.title,
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
  if (owned.length > 0) {
    fail(
      'visual-sweep-gate: this pull request added or changed a baseline that does not match its own ' +
        `screenshot (record baselines in the pinned image: npm run -s test:visual:docker:update):\n- ${owned.join('\n- ')}`,
    );
  }

  console.log(
    `visual-sweep-gate: ${ran} test(s) executed ` +
      `(expected=${stats.expected ?? 0}, unexpected=${stats.unexpected ?? 0}, ` +
      `flaky=${stats.flaky ?? 0}, skipped=${stats.skipped ?? 0}). ` +
      `PR-owned baseline failures: ${owned.length}. Other diffs stay advisory.`,
  );
}

if (process.argv[1] && process.argv[1].endsWith('visual-sweep-gate.mjs')) {
  main();
}
