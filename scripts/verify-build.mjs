// Post-build smoke verification. Runs as the final step of `npm run build`
// so a shipped VSIX missing an entrypoint (e.g. dist/cli/main.js — the
// agent-facing CLI, a separate esbuild bundle from dist/extension.js; see
// docs/arch/cli.md) can never ship silently again.
//
// This is a build script, not an extension-host path — spawnSync here does
// not violate the "spawnSync is banned on any gate path" invariant.
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const REQUIRED_ARTIFACTS = [
  'dist/extension.js',
  'dist/cli/main.js',
  // The generated, type-checked webview message-sender bundles. A missing one
  // means every control in that webview silently no-ops at runtime, so the
  // shipped VSIX must never omit it. The dashboard sender is its own bundle;
  // the settings sender folded into `app.webview.js` at phase 4 (NDL-126 §8.4),
  // so the settings sender is verified through the app bundle below.
  'dist/ui/dashboard/webviewSend.webview.js',
  'dist/ui/settings/app.webview.js',
];

// NDL-126 §7 budget: React 19 production + ReactDOM is ~190 KB min, so a
// settings app bundle over 350 KB means something unintended got bundled in.
const APP_BUNDLE_BUDGET_BYTES = 350 * 1024;
const APP_BUNDLE = 'dist/ui/settings/app.webview.js';

function fail(message) {
  console.error(`verify-build: ${message}`);
  process.exit(1);
}

for (const artifact of REQUIRED_ARTIFACTS) {
  if (!existsSync(artifact)) {
    fail(`missing build artifact: ${artifact}`);
  }
  const { size } = statSync(artifact);
  if (size === 0) {
    fail(`build artifact is empty: ${artifact}`);
  }
}

{
  const { size } = statSync(APP_BUNDLE);
  if (size > APP_BUNDLE_BUDGET_BYTES) {
    fail(
      `${APP_BUNDLE} is ${size} bytes, over the ${APP_BUNDLE_BUDGET_BYTES} byte budget (NDL-126 §7)`,
    );
  }
}

// Smoke-run the CLI's `guide` verb — static content, no DB — to confirm the
// bundled dist/cli/main.js is actually runnable, not just present.
const result = spawnSync(process.execPath, ['dist/cli/main.js', 'guide'], {
  encoding: 'utf8',
});

if (result.error) {
  fail(`failed to spawn dist/cli/main.js guide: ${result.error.message}`);
}
if (result.status !== 0) {
  fail(
    `dist/cli/main.js guide exited with code ${result.status}\nstderr:\n${result.stderr}`,
  );
}
if (!result.stdout || result.stdout.trim().length === 0) {
  fail('dist/cli/main.js guide produced no stdout');
}

console.log(
  'verify-build: ok (dist/extension.js, dist/cli/main.js, webview bundles, settings app budget, guide smoke test)',
);
