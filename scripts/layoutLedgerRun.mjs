/**
 * `node scripts/layoutLedgerRun.mjs seed|prune` — sets the ledger intent env and
 * runs the authoritative docker layout run. A wrapper instead of an inline
 * `KARST_LAYOUT_PRUNE=1 npm run ...` so it also works on Windows hosts
 * (no cross-env dependency).
 */
import { spawnSync } from 'node:child_process';

const INTENT_ENV = { seed: 'KARST_LAYOUT_SEED', prune: 'KARST_LAYOUT_PRUNE' };
const mode = process.argv[2];
const name = INTENT_ENV[mode];
if (name === undefined) {
  console.error('usage: node scripts/layoutLedgerRun.mjs seed|prune');
  process.exit(2);
}

const result = spawnSync('npm run test:layout:docker', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, [name]: '1' },
});
process.exit(result.status ?? 1);
