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
  'dist/sandbox/opencode/allowlist-proxy.mjs',
  'dist/sandbox/opencode/Dockerfile',
  // The generated, type-checked webview message-sender bundles. A missing one
  // means every control in that webview silently no-ops at runtime, so the
  // shipped VSIX must never omit it. The dashboard sender is its own bundle;
  // the settings sender folded into `app.webview.js` at phase 4 (NDL-126 §8.4),
  // so the settings sender is verified through the app bundle below.
  'dist/ui/dashboard/webviewSend.webview.js',
  'dist/ui/dashboard/app.webview.js',
  'dist/ui/resources/app.webview.js',
  'dist/ui/sidebar/app.webview.js',
  'dist/ui/settings/app.webview.js',
];

// NDL-126 §7 budget: React 19 production + ReactDOM is ~190 KB min, so a
// settings app bundle far over 350 KB means something unintended got bundled in.
// Raised 350 → 354 KB for the multi-service Services editor (named `services:`
// map per repository: per-service blocks, split/add/remove, repo/service
// dependency targets), which added ~4 KB of genuine app code on a ~356 KB base.
// Raised 354 → 356 KB for the pending-outputs panel on the Approaches card (~1.3 KB).
// Raised 356 → 358 KB for the aligned Roles table (KarstMark, SourceCell and the
// one-grid cell contract, ~1.4 KB).
// Raised 358 → 360 KB independently by two branches that landed together: the
// per-repository `ship.exclude` list on the Repositories card (the exclude chips
// + composer) and per-repo git convention overrides (three template fields plus
// a per-repo preview on the same card). Each fit under 360 KB alone, but the
// merged bundle — both features' genuine app code in one build — is 369221
// bytes, so the merged cap is raised 360 → 362 KB (~1.4 KB headroom).
// Raised 362 → 364 KB for the sandbox backend panel on the Agents page (selector,
// per-core effective-backend line, sbx/docker status; ~1.5 KB of genuine app code
// plus the shared pure `deriveEffectiveBackends`).
// Raised 364 → 366 KB when the sandbox branch merged with develop's per-core
// quota card (D163): each fit alone, the merged bundle is 372815 bytes.
// Raised 366 → 368 KB when the stopServersOnDone select in General settings
// (D205, ~0.3 KB) merged with develop's three-tier click feedback in useHostMutation:
// merged bundle is 375569 bytes (~1.2 KB headroom).
// Raised 368 → 370 KB for the Agents page accessibility work (T773): unsaved-bar
// focus/Escape, the section-leave guard (context + shell + Agents), Source
// reasons as SR text plus the status line, the matrix differs dot and Home/End
// on the tabs — ~2.3 KB of genuine app code on a 375569-byte base, so the merged
// bundle is 377860 bytes. This is the first raise where the previous 1.2 KB
// cushion was smaller than the feature, hence the 2 KB step.
// Raised 370 → 372 KB for the `archivePlanningAfterDays` field in General settings
// (~0.3 KB of genuine app code; the 370 KB cap had under 0.1 KB left): bundle is
// 379204 bytes (~1.7 KB headroom).
const APP_BUNDLE_BUDGET_BYTES = 372 * 1024;
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
