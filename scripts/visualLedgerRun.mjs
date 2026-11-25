/**
 * `node scripts/visualLedgerRun.mjs prune` — the prune path of the visual
 * ledger (scripts/visualLedger.mjs, `@ui:RUNNING-SWEEP`).
 *
 * 1. Runs the whole sweep in the pinned image (npm run test:visual:docker).
 *    Its exit code is not the verdict: ledgered failures make it red.
 * 2. Lists the full sweep (no browser, no web server) into a temporary file.
 * 3. Runs scripts/visual-sweep-gate.mjs with KARST_VISUAL_PRUNE=1,
 *    KARST_VISUAL_AUTHORITATIVE=1 and that listing. The gate removes the stale
 *    entries only on a full run, and refuses on a partial one.
 *
 * KARST_VISUAL_PRUNE also stops scripts/dockerGate.mjs from narrowing the sweep
 * to a repeat pass (@arch:GATE-REPEAT). A wrapper instead of an inline env
 * assignment, so that it also works on Windows hosts (as layoutLedgerRun.mjs).
 */
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.argv[2] !== 'prune') {
  console.error('usage: node scripts/visualLedgerRun.mjs prune');
  process.exit(2);
}

/** scripts/dockerGate.mjs exits with it when neither docker nor the pinned image is available. */
const EXIT_NO_DOCKER = 127;

// A grep or a fixture-view filter would make the sweep partial: the prune must see the whole sweep.
const { KARST_UI_GREP: _grep, KARST_VISUAL_FIXTURE_VIEWS: _views, ...inherited } = process.env;
const env = { ...inherited, KARST_VISUAL_PRUNE: '1', KARST_VISUAL_AUTHORITATIVE: '1' };
// A report left by an earlier run must never stand in for this sweep.
rmSync('tests/visual/.results.json', { force: true });
const sweep = spawnSync('npm run test:visual:docker', { stdio: 'inherit', shell: true, env });
if (sweep.status === EXIT_NO_DOCKER) {
  console.error('the docker sweep did not run; the ledger was not pruned');
  process.exit(EXIT_NO_DOCKER);
}
console.error(`visual sweep exit code: ${sweep.status ?? sweep.signal} (the gate below decides the prune)`);

const dir = mkdtempSync(join(tmpdir(), 'karst-visual-listing-'));
let status = 1;
try {
  const listing = join(dir, 'listed.json');
  const fd = openSync(listing, 'w');
  let list;
  try {
    list = spawnSync('npx playwright test --list --reporter=json', { stdio: ['ignore', fd, 'inherit'], shell: true, env });
  } finally {
    closeSync(fd);
  }
  if (list.status !== 0) {
    console.error(`cannot list the sweep (exit ${list.status ?? list.signal}); the ledger was not pruned`);
  } else {
    const gate = spawnSync(process.execPath, ['scripts/visual-sweep-gate.mjs'], {
      stdio: 'inherit',
      env: { ...env, VISUAL_LISTED_REPORT: listing },
    });
    status = gate.status ?? 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
