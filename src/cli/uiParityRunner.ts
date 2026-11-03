import { execFile } from 'node:child_process';
import type { ParityResult } from '../workflow/uiParityGuard.js';

const PARITY_DIR = 'src/ui/dashboard/parity';
const PARITY_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** Pull failing snapshot names (or failing test lines) out of vitest output. */
export function parseParityFailures(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/Snapshot `([^`]+)` mismatched/g)) names.add(m[1]!);
  if (names.size === 0) {
    for (const m of output.matchAll(/^\s*(?:FAIL|×)\s+(.+)$/gm)) names.add(m[1]!.trim());
  }
  return [...names];
}

/**
 * Run the fast parity vitest (about 10 s) in `cwd`. Async, so the CLI never
 * blocks on it. A timeout or a spawn error is not a verdict: it throws, and the
 * caller lets the marker through.
 */
export function runParityVitest(cwd: string): Promise<ParityResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'npx',
      ['vitest', 'run', '--config', 'vitest.integration.config.ts', PARITY_DIR],
      { cwd, timeout: PARITY_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, CI: '1' } },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, failures: [] });
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code !== 'number') return reject(error); // spawn error or timeout
        resolve({ ok: false, failures: parseParityFailures(`${stdout}\n${stderr}`) });
      },
    );
  });
}
