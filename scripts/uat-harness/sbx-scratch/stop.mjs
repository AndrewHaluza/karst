// sbx-scratch harness stop: remove the scratch sandbox; success when it is already gone.
import { rmSync } from 'node:fs';
import { removeIfPresent, scratchFolder, scratchName } from './common.mjs';

try {
  const name = process.env.KARST_SBX_SCRATCH || scratchName(process.env);
  const out = removeIfPresent(name);
  if (!out.ok) throw new Error(`sbx rm ${name} failed: ${out.reason}`);
  rmSync(scratchFolder(name), { recursive: true, force: true });
} catch (err) {
  process.stderr.write(`sbx-scratch stop: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
