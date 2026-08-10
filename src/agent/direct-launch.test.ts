import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApproachPrompt } from '../approaches/resolve.js';
import { buildSessionSeed } from './seed.js';
import { renderTicketContext } from '../context/ticketContext.js';
import { ClaudeAdapter } from './claude.js';
import type { ApproachDef } from '../manifest/types.js';

/**
 * End-to-end launch path for the built-in `direct` approach, exercising the same
 * code openSession runs: resolve (no entrypoint → null) → seed (ticket context)
 * → build the interactive command. Proves `direct` opens WITH ticket context,
 * not a dull empty session (the reported bug).
 */
describe('direct approach launch path (integration)', () => {
  const DIRECT: ApproachDef = {
    id: 'direct',
    label: 'Direct implementation',
    description: 'Small, fully-clear change; just implement.',
    // no source, no entrypoint — the built-in case
  };

  it('opens the session seeded with full ticket context (no approach method)', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'karst-direct-'));
    try {
      // 1. Resolve the approach method — a built-in resolves to null.
      const approachPrompt = resolveApproachPrompt(baseDir, [DIRECT], 'direct');
      expect(approachPrompt).toBeNull();

      // 2. Seed from the ticket context — this is what was missing before the fix.
      const contextMarkdown = renderTicketContext({
        key: 'ACME-42',
        title: 'Add rate limiting to /login',
        prompt: 'Brute-force protection missing on the auth endpoint.',
        brief: 'Cap login attempts per IP; return 429 past the threshold.',
        approach: 'direct',
        agent: null,
        parent: null,
        stageCurrent: null,
        selectedRepos: ['backend'],
        worktrees: [],
        servers: [],
        prs: [],
        attachments: [],
        repos: [
          {
            name: 'backend',
            repoPath: '/repo/backend',
            start: 'npm run dev',
            runnable: true,
            unknown: false,
          },
        ],
        stage: null,
      });
      const seed = buildSessionSeed(contextMarkdown, approachPrompt);
      expect(seed).toBeDefined();

      // 3. Build the real interactive command and assert the seed rides through.
      const cmd = new ClaudeAdapter().buildInteractiveCommand({
        cwd: '/wt/acme-42',
        ...(seed ? { initialPrompt: seed } : {}),
      });

      // `--` separates options from the positional seed.
      const sepIdx = cmd.args.indexOf('--');
      expect(sepIdx).toBeGreaterThanOrEqual(0);
      const positional = cmd.args[sepIdx + 1]!;

      expect(positional).toContain('ACME-42 — Add rate limiting to /login');
      expect(positional).toContain('Brute-force protection missing');
      expect(positional).toContain('Cap login attempts per IP');
      expect(positional).toContain('- backend');
      // No approach method section, since direct has none.
      expect(positional).not.toContain('# Approach');
      // No workflow invocation, since direct has no workflow.
      expect(positional).not.toContain('/karst:');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
