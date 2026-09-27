// Build webview-side TypeScript into JavaScript that gets injected into HTML.
// These scripts are type-checked against message contracts to catch silent-drop failures.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const entries = [
  { input: 'src/ui/dashboard/webview-messages.ts', output: '.cache/webview-messages-dashboard.js' },
  { input: 'src/ui/settings/webview-messages.ts', output: '.cache/webview-messages-settings.js' },
];

mkdirSync('.cache', { recursive: true });

for (const { input, output } of entries) {
  try {
    await build({
      entryPoints: [input],
      outfile: output,
      format: 'iife',
      platform: 'browser',
      bundle: true,
      minify: false,
      sourcemap: false,
      external: [], // Browser code has no externals
      target: 'es2020',
      logLevel: 'error',
    });
    console.log(`built ${input} → ${output}`);
  } catch (e) {
    console.error(`failed to build ${input}:`, e.message);
    process.exit(1);
  }
}
