import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullResult, Reporter } from '@playwright/test/reporter';
import { cleanTmpAfterRun, ownsPages } from './tmpCleanup.js';

const TMP_DIR = join(dirname(fileURLToPath(import.meta.url)), '.tmp');

/** Playwright reporter: removes the generated fixture pages when the whole run passed and this run started the server that serves them. */
export default class TmpCleanupReporter implements Reporter {
  onEnd(result: FullResult): void {
    if (ownsPages(TMP_DIR)) cleanTmpAfterRun(result.status, TMP_DIR);
  }

  printsToStdio(): boolean {
    return false;
  }
}
