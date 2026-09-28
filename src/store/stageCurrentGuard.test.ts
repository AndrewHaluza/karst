import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTrackedFiles } from '../agent/agentsTree.js';

/**
 * Single-writer guard (NDL-37): `tickets.stage_current` has exactly one
 * writer, `setStageCurrent` (store/tickets.ts). Everything else that used to
 * reach for a raw `UPDATE tickets SET ... stage_current` — the stage machine,
 * the send-back/reset-stage/pr-feedback-fix recovery mutations, boot
 * reconciliation, the CLI test helper — now calls it, so a future change to
 * what moving a ticket means (validation, event emission, invariant checks)
 * cannot be silently bypassed by a call site that skipped it.
 *
 * Scans GIT-TRACKED source files rather than the on-disk tree for the same
 * reason `agentsTreeGuard.test.ts` does, and skips `store/` (where the one
 * legitimate writer and a one-time schema migration live) and test files
 * (which raw-write the column directly on an in-memory DB as fixture setup,
 * never through production code paths).
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RAW_WRITE = /\bUPDATE\s+tickets\s+SET\b[^;]*\bstage_current\b/i;

describe('stage_current single-writer discipline', () => {
  it('has no raw UPDATE of stage_current outside store/', () => {
    const offenders: string[] = [];
    for (const file of listTrackedFiles(REPO_ROOT, 'src')) {
      const rel = relative(REPO_ROOT, file);
      if (rel.startsWith('src/store/')) continue;
      if (rel.endsWith('.test.ts')) continue;
      if (!existsSync(file)) continue;
      if (RAW_WRITE.test(readFileSync(file, 'utf8'))) {
        offenders.push(rel);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
