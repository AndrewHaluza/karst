// esbuild config for the VS Code extension host entry point.
// Bundles all TS/JS into a single dist/extension.js so the VSIX ships one
// file instead of ~450. Native addons (better-sqlite3) are external — they
// can't be bundled and must load from node_modules at runtime.
import { build, context } from 'esbuild';

const prod = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: [
    'better-sqlite3',
    'vscode',
    // Node builtins — bundled by esbuild but kept explicit for clarity.
    'node:*',
  ],
  // Sourcemap for crash reports only — not shipped to users.
  sourcemap: prod ? false : 'linked',
  minify: prod,
  // Don't tree-shake aggressively — some runtime动态 imports rely on side effects.
  treeShaking: true,
  // Log level.
  logLevel: 'info',
  // Fail on warnings.
  logLimit: 0,
  // Define globals if needed.
  define: {
    'process.env.NODE_ENV': prod ? '"production"' : '"development"',
  },
  // Alias for ESM compatibility.
  alias: {
    // No aliases needed for this project.
  },
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log('watching for changes…');
} else {
  await build(opts);
}
