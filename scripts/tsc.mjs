// Runs the TypeScript compiler resolved by Node module resolution, not a
// cwd-relative `node_modules/...` path: a ticket worktree inherits deps from an
// ancestor node_modules, which a literal relative file path never walks to.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const HEAP_MB = 4096;
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const r = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, tsc, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
