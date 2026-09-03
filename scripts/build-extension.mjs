// esbuild config for the two runtime entrypoints this VSIX ships.
// dist/extension.js: the VS Code extension host entry point. Bundles all
// TS/JS into a single file so the VSIX ships one file instead of ~450.
// Native addons (better-sqlite3) are external — they can't be bundled and
// must load from node_modules at runtime.
// dist/cli/main.js: the agent-facing `karst` CLI (src/cli/main.ts). It is
// invoked directly by agents with plain `node`, never through VS Code, and
// uses node:sqlite (never better-sqlite3) — see docs/arch/cli.md. It is the
// ONLY other runtime entrypoint referenced anywhere, so it must be bundled
// too or shipped VSIXs are missing it entirely (MODULE_NOT_FOUND for every
// agent CLI verb).
import { build, context } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const prod = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const base = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: [
    'better-sqlite3',
    'vscode',
    // Node builtins — bundled by esbuild but kept explicit for clarity.
    'node:*',
  ],
  // Sourcemap for crash reports only — not shipped to users.
  sourcemap: prod ? false : 'linked',
  minify: prod,
  // Don't tree-shake aggressively — some runtime dynamic imports rely on side effects.
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

/** @type {import('esbuild').BuildOptions} */
const extensionOpts = {
  ...base,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
};

/** @type {import('esbuild').BuildOptions} */
const cliOpts = {
  ...base,
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/cli/main.js',
  // `vscode` stays external in `base`, but the CLI must never actually
  // reach it — it runs under plain `node`, not the extension host. If
  // esbuild ever reports a `vscode` import in this graph, that's a real
  // layering bug to fix, not something to paper over with an external.
  //
  // esbuild drops shebangs on bundle, so a banner is needed to keep
  // `dist/cli/main.js` directly executable (`node dist/cli/main.js ...`).
  // src/cli/main.ts also carries its own `#!/usr/bin/env node` shebang
  // (useful when running the source directly under tsx); strip that
  // line from esbuild's output first so the banner isn't duplicated.
  banner: { js: '#!/usr/bin/env node' },
};

// If the CLI banner and a preserved source shebang both land at the top of
// dist/cli/main.js, drop the duplicate — the file must start with exactly
// one `#!/usr/bin/env node` line to be valid JS and directly executable.
function dedupeShebang(outfile) {
  const contents = readFileSync(outfile, 'utf8');
  const shebang = '#!/usr/bin/env node\n';
  if (contents.startsWith(shebang + shebang)) {
    writeFileSync(outfile, contents.slice(shebang.length));
  }
}

if (watch) {
  const [extCtx, cliCtx] = await Promise.all([context(extensionOpts), context(cliOpts)]);
  await Promise.all([extCtx.watch(), cliCtx.watch()]);
  console.log('watching for changes…');
} else {
  await build(extensionOpts);
  await build(cliOpts);
  dedupeShebang(cliOpts.outfile);
}
