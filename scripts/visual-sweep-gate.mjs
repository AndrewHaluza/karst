/**
 * CI gate for the advisory visual sweep (.github/workflows/ci.yml).
 *
 * The sweep step is advisory for screenshot DIFFS: the suite is still
 * settling, so a red baseline must not block a PR.  It must NOT be advisory
 * for a run that executed zero tests — before NDL-218 the webServer died on
 * startup (ENOENT webviewSend.webview.js) and `continue-on-error: true` still
 * recorded conclusion=success, so PRs showed a green job that had never run
 * a single test.
 *
 * Reads the `json` reporter's output (tests/visual/.results.json, written by
 * playwright.config.ts) and exits non-zero when no test produced a result.
 *
 * `stats.skipped` is deliberately NOT counted as "ran": Playwright computes a
 * test's outcome as `skipped` when it has no results at all (see
 * computeTestCaseOutcome), so a crash between report-begin and the first
 * executed test would otherwise look like a full run of skipped tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const RESULTS_PATH = join(root, 'tests', 'visual', '.results.json');

function fail(message) {
  const annotation = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
  console.error(`${annotation}${message}`);
  process.exit(1);
}

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

/** Flattened specs of a Playwright JSON report, each tagged with the project of its results. */
function* projectSpecs(node, project) {
  for (const spec of node.specs ?? []) {
    for (const t of spec.tests ?? []) {
      yield { project: t.projectName ?? project, status: t.status, title: spec.title };
    }
  }
  for (const child of node.suites ?? []) yield* projectSpecs(child, project);
}

function layoutGateProblems(rep) {
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

const stats = report.stats ?? {};
const ran =
  (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0);

if (ran <= 0) {
  fail(
    `visual-sweep-gate: the sweep executed 0 tests (stats: ${JSON.stringify(stats)}).`,
  );
}

// Layout-sanity gate (ui:LAYOUT-SANITY). Geometry never fails a `layout` test, so
// `unexpected` there is a harness error; in `layout-teardown` it is the ledger
// verdict (a new or stale entry, or a seed/prune refusal). Screenshot diffs in the
// other projects stay advisory.
const layoutProblems = layoutGateProblems(report);
if (layoutProblems.length > 0) {
  fail(`visual-sweep-gate: layout gate failed:\n- ${layoutProblems.join('\n- ')}`);
}

console.log(
  `visual-sweep-gate: ${ran} test(s) executed ` +
    `(expected=${stats.expected ?? 0}, unexpected=${stats.unexpected ?? 0}, ` +
    `flaky=${stats.flaky ?? 0}, skipped=${stats.skipped ?? 0}). ` +
    'Diffs, if any, stay advisory.',
);