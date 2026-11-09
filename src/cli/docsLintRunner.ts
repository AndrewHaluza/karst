import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const LINT_SCRIPT = 'scripts/docsKeys.mjs';
const LINT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Run the docs block lint (about 1 s) in `cwd` and return stdout plus stderr.
 * Async, so the CLI never blocks on it. Exit 1 is a normal verdict. A timeout or
 * a spawn error throws, and the caller lets the marker through.
 */
export function runDocsLint(cwd: string): Promise<string> {
  // Not a karst checkout (another ticket repo with its own docs/): nothing to run.
  if (!existsSync(join(cwd, LINT_SCRIPT))) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [LINT_SCRIPT, 'lint'],
      { cwd, timeout: LINT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          if (typeof code !== 'number') return reject(error); // spawn error or timeout
        }
        resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}
