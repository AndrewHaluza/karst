import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Set to any non-empty value to keep the generated pages after a passed run (debugging a fixture). */
export const KEEP_TMP_ENV = 'KARST_VISUAL_KEEP_TMP';

/**
 * T992: `tests/visual/.tmp` holds one page per view, variant and theme, and each dashboard page inlines the whole
 * 1.15 MB webview bundle: about 800 MB per worktree. The pages are build products (`serve.mjs` rewrites all of them at
 * every start), so a PASSED run removes them. A failed, interrupted or timed-out run keeps them for diagnosis; the
 * next run clears them first (`writeFixtures`).
 */
export function cleanTmpAfterRun(status: string, dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (status !== 'passed' || (env[KEEP_TMP_ENV] ?? '') !== '') return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The run id the Playwright config sets; `serve.mjs` writes it into {@link OWNER_FILE} when this run started the server. */
export const RUN_ID_ENV = 'KARST_VISUAL_RUN_ID';
export const OWNER_FILE = '.owner';

/**
 * True when the pages in `dir` belong to this run's own server. A reused server (`reuseExistingServer`) was started by
 * another run, still serves those pages, and writes another id (or none), so this run must not remove them.
 */
export function ownsPages(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = env[RUN_ID_ENV] ?? '';
  if (id === '') return false;
  try {
    return readFileSync(join(dir, OWNER_FILE), 'utf8').trim() === id;
  } catch {
    return false;
  }
}
