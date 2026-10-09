// Bundle each webview's type-checked TypeScript entry (TS/TSX) to the IIFE
// `*.webview.js` the injector reads at webview-render time.
//
// The message constructors live in `src/ui/<view>/webviewSend.ts`, checked
// against the host's message union by `tsc --noEmit`; the HTML only calls the
// named functions. esbuild turns each entry into a self-contained IIFE that
// acquires VS Code's API ONCE and exposes `vscode` + `karstSend` as globals.
//
// The settings React app (`src/ui/settings/app/main.tsx`) rides the SAME
// pipeline — NDL-126 §1: one pipeline, per-entry options, no second build
// system. Since phase 4 the settings app IS the settings sender: `main.tsx`
// imports `webviewSend.ts` directly and is the document's single
// `acquireVsCodeApi()` caller, so the standalone settings sender entry
// (`webviewSend.entry.ts`) is retired and only the app bundle ships.
// Its options are explicit because a React bundle needs
// `jsx: 'automatic'` and a fixed production `process.env.NODE_ENV` so the
// bundle tests exercise runs the exact code the shipped VSIX runs.
//
// Output lands in `src/` (mirrored to `dist/` by `scripts/copy-assets.mjs`),
// exactly like the hand-authored `model/agentPicker.webview.js`, so
// `readFileSync(join(RUNTIME_ASSETS_ROOT, …))` resolves in both the unbundled
// test world (root = src/) and the shipped extension (root = dist/). The
// generated files are gitignored build products and are rebuilt by the vitest
// globalSetup so unit tests can hydrate the webviews too.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Input entry → generated bundle, both repo-root-relative, plus that entry's
 * esbuild overrides. Entries that do not override an option inherit the
 * baseline (the historical sender-bundle settings).
 */
export const WEBVIEW_BUNDLE_ENTRIES = [
  {
    input: 'src/ui/dashboard/webviewSend.entry.ts',
    output: 'src/ui/dashboard/webviewSend.webview.js',
  },
  {
    input: 'src/ui/settings/app/main.tsx',
    output: 'src/ui/settings/app.webview.js',
    jsx: 'automatic',
    // ALWAYS production, even in dev/test builds (NDL-126 §1): React's
    // development build would add ~2x weight plus dev-only warnings, and the
    // whole point of the harness running the bundle is that it runs the same
    // React build the shipped webview runs.
    define: { 'process.env.NODE_ENV': '"production"' },
    minifyFromProd: true,
  },
];

const BASE_OPTIONS = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
};

/**
 * Bundle every webview TypeScript entry. Throws (never swallows) on a build
 * error. `prod` only affects entries that opt in via `minifyFromProd` — the
 * message-sender bundles have always shipped unminified and stay that way.
 * `quiet` skips the per-bundle "built" line (the vitest global setup passes it).
 */
export async function buildWebviewBundles({ prod = false, quiet = false } = {}) {
  for (const entry of WEBVIEW_BUNDLE_ENTRIES) {
    const { input, output, minifyFromProd, ...overrides } = entry;
    await build({
      ...BASE_OPTIONS,
      entryPoints: [join(root, input)],
      outfile: join(root, output),
      ...(minifyFromProd ? { minify: prod } : null),
      ...overrides,
    });
    if (!quiet) console.log(`built ${input} → ${output}`);
  }
}

// Direct invocation (`node scripts/build-webview-send.mjs`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildWebviewBundles({ prod: process.argv.includes('--production') });
}
