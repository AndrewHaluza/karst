/**
 * Cross-process regression for the T661 UAT medium finding.
 *
 * Without a lock, N launches trusting DIFFERENT workspaces all read the same
 * `~/.claude.json`, all merge, and the last rename wins — dropping the earlier
 * records, so those workspaces still opened on Claude's "No, exit" dialog. This
 * spawns real child processes (hence `*.integration.test.*`) against one
 * isolated HOME and synchronises them on a barrier so their reads collide, then
 * asserts every record landed.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trustKeyFor } from './workspaceTrust.js';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, 'workspaceTrust.ts');
const tsxBin = resolve(here, '../../node_modules/.bin/tsx');

function runTrust(cwd: string, home: string, startAt: number): Promise<void> {
  // The barrier spins every child until the same instant, so all of them read
  // the initial (empty) config together — the race the lock must serialise.
  const script =
    `import { ensureClaudeWorkspaceTrusted } from ${JSON.stringify(modulePath)};` +
    ` const start = Number(process.env.KARST_TRUST_TEST_START);` +
    ` while (Date.now() < start) {}` +
    ` ensureClaudeWorkspaceTrusted(${JSON.stringify(cwd)}, { home: ${JSON.stringify(home)} });`;
  return new Promise((resolvePromise, reject) => {
    execFile(
      tsxBin,
      ['-e', script],
      { timeout: 25_000, env: { ...process.env, KARST_TRUST_TEST_START: String(startAt) } },
      (err) => (err ? reject(err) : resolvePromise()),
    );
  });
}

describe('workspace trust across concurrent processes (integration)', () => {
  it('records EVERY directory when 8 launches trust distinct workspaces at once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'karst-trust-concurrent-'));
    try {
      const dirs = Array.from({ length: 8 }, (_, i) => join(home, `worktree-${i}`));
      // Enough lead time for every `tsx` child to boot and reach the barrier.
      const startAt = Date.now() + 2_000;
      await Promise.all(dirs.map((d) => runTrust(d, home, startAt)));

      const { projects } = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
        projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      for (const d of dirs) {
        expect(projects[trustKeyFor(d)]?.hasTrustDialogAccepted, d).toBe(true);
      }
      // The lock file is gone once every writer finished.
      expect(existsSync(join(home, '.claude.json.karst-trust.lock'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

