// sbx-scratch harness start: one empty-folder sandbox for the UAT Tester (@arch:UAT-HARNESS).
// Prints one JSON line {"env":{"KARST_SBX_SCRATCH":"<name>"}} on success.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listed, removeIfPresent, sbx, scratchName } from './common.mjs';

const CORE = 'claude';
const WAIT_MS = 60_000;
const POLL_MS = 1_000;

const fail = (message) => {
  process.stderr.write(`sbx-scratch start: ${message}\n`);
  process.exit(1);
};

try {
  const name = scratchName(process.env);
  const left = removeIfPresent(name);
  if (!left.ok) fail(`cannot remove the leftover sandbox ${name}: ${left.reason}`);
  const folder = mkdtempSync(join(tmpdir(), 'karst-uat-scratch-'));
  const created = sbx(['create', '--name', name, CORE, folder], WAIT_MS * 2);
  if (created.code !== 0) fail(`sbx create failed: ${created.stderr.trim()}`);
  const deadline = Date.now() + WAIT_MS;
  while (!listed(name)) {
    if (Date.now() > deadline) fail(`sbx ls does not show ${name} after ${WAIT_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  process.stdout.write(`${JSON.stringify({ env: { KARST_SBX_SCRATCH: name } })}\n`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
