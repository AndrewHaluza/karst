import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What karst learned when it looked for a repository's npm scripts.
 *
 * Discriminated deliberately. `readPackageScripts` collapsed four situations into
 * `{}`, so a malformed package.json and a repo with no tests were the same answer
 * — and both produced a vacuous green. They are different questions with
 * different owners: a malformed file is a repository defect an agent can fix, a
 * permission error is environmental and an agent cannot chmod its way out of it.
 */
export type ScriptProbe =
  | { kind: 'ok'; scripts: Record<string, string> }
  | { kind: 'absent' }
  | { kind: 'malformed'; message: string }
  | { kind: 'io-error'; message: string };

/** Read `<cwd>/package.json`'s scripts block, saying WHY when it cannot. */
export function probeScripts(cwd: string, debug?: (message: string) => void): ScriptProbe {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, 'package.json'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      debug?.(`[gate] probe ${cwd}: no package.json`);
      return { kind: 'absent' };
    }
    const message = error instanceof Error ? error.message : String(error);
    debug?.(`[gate] probe ${cwd}: io-error (${message})`);
    return { kind: 'io-error', message };
  }
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    debug?.(
      `[gate] probe ${cwd}: ${Object.keys(scripts).length} script(s) read — ` +
        `${Object.keys(scripts).slice(0, 8).join(', ') || 'none'}`,
    );
    return { kind: 'ok', scripts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug?.(`[gate] probe ${cwd}: malformed package.json (${message})`);
    return { kind: 'malformed', message };
  }
}
