// Bundle each webview's type-checked message-sender entry (TS) to the IIFE
// `*.webview.js` the injector reads at webview-render time.
//
// The message constructors live in `src/ui/<view>/webviewSend.ts`, checked
// against the host's message union by `tsc --noEmit`; the HTML only calls the
// named functions. esbuild turns each entry into a self-contained IIFE that
// acquires VS Code's API ONCE and exposes `vscode` + `karstSend` as globals.
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

/** Input entry → generated bundle, both repo-root-relative. */
export const WEBVIEW_SEND_ENTRIES = [
  {
    input: 'src/ui/dashboard/webviewSend.entry.ts',
    output: 'src/ui/dashboard/webviewSend.webview.js',
  },
  {
    input: 'src/ui/settings/webviewSend.entry.ts',
    output: 'src/ui/settings/webviewSend.webview.js',
  },
];

/** Bundle every webview sender entry. Throws (never swallows) on a build error. */
export async function buildWebviewSenders() {
  for (const { input, output } of WEBVIEW_SEND_ENTRIES) {
    await build({
      entryPoints: [join(root, input)],
      outfile: join(root, output),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      sourcemap: false,
      minify: false,
      logLevel: 'warning',
    });
    console.log(`built ${input} → ${output}`);
  }
}

// Direct invocation (`node scripts/build-webview-send.mjs`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildWebviewSenders();
}
