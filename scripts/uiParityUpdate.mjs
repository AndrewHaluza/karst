/**
 * `npm run ui:parity:update` — refreshes the dashboard parity snapshot, then
 * prunes the layout ledger (or seeds it when the file is missing). One command
 * for the marker refusal in `src/workflow/uiParityGuard.ts` (@ui:LEDGER-SHIFT).
 * Review the snapshot diff before you commit: it must match the intended change.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const LEDGER = 'tests/visual/layout-known-failures.json';
const steps = [
  ['npx', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'src/ui/dashboard/parity', '-u'],
  ['node', 'scripts/layoutLedgerRun.mjs', existsSync(LEDGER) ? 'prune' : 'seed'],
];
for (const [cmd, ...args] of steps) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
