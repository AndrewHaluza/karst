import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullResult, Reporter } from '@playwright/test/reporter';
import { fixtureDir } from './fixtureDir.mjs';
import { cleanTmpAfterRun, ownsPages } from './tmpCleanup.js';

// The same directory that serve.mjs serves (KARST_VISUAL_TMP_DIR, else tests/visual/.tmp).
const TMP_DIR = fixtureDir(process.env, join(dirname(fileURLToPath(import.meta.url)), '.tmp'));

/** Playwright reporter: removes the generated fixture pages when the whole run passed and this run started the server that serves them. */
export default class TmpCleanupReporter implements Reporter {
  onEnd(result: FullResult): void {
    if (ownsPages(TMP_DIR)) cleanTmpAfterRun(result.status, TMP_DIR);
  }

  printsToStdio(): boolean {
    return false;
  }
}
