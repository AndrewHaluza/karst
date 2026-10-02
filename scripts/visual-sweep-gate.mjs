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

const stats = report.stats ?? {};
const ran =
  (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0);

if (ran <= 0) {
  fail(
    `visual-sweep-gate: the sweep executed 0 tests (stats: ${JSON.stringify(stats)}).`,
  );
}

console.log(
  `visual-sweep-gate: ${ran} test(s) executed ` +
    `(expected=${stats.expected ?? 0}, unexpected=${stats.unexpected ?? 0}, ` +
    `flaky=${stats.flaky ?? 0}, skipped=${stats.skipped ?? 0}). ` +
    'Diffs, if any, stay advisory.',
);