import { rmSync } from 'node:fs';

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
