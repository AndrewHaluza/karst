import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { startHookEndpoint } from '../hooks/endpoint.js';
import { OpencodeAdapter } from './opencode.js';

/**
 * The opencode v1 half of the mail reply channel: the endpoint answers a
 * `session.idle` POST with a block body, and the generated plugin pushes the
 * reason through `client.session.promptAsync` (the same SDK channel the resumed
 * kickoff uses). Spawns no process but drives the REAL endpoint + generated
 * plugin + a fake SDK client → integration suite.
 */

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc-mail-'));
  temporaryRoots.push(root);
  return root;
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before the timeout');
}

describe('opencode session.idle mail reply', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('pushes the endpoint reason through promptAsync', async () => {
    store = openStore(':memory:');
    const worktree = makeWorktree();
    const ticket = createTicketFlow(store, { key: 'OC-MAIL', title: 'mail' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`,
      )
      .run(ticket.id, worktree);

    const endpoint = await startHookEndpoint(store, 0, undefined, undefined, undefined, undefined, {
      hookReply: ({ event }) =>
        event === 'session.idle'
          ? { decision: 'block', reason: 'karst: 1 new message(s) - run inbox' }
          : null,
    });
    try {
      const configDir = join(worktree, '.karst-runtime');
      mkdirSync(configDir, { recursive: true });
      const cmd = new OpencodeAdapter().buildInteractiveCommand({
        cwd: worktree,
        hookChannel: { endpointUrl: endpoint.url, configDir },
      });
      for (const [key, value] of Object.entries(cmd.env)) vi.stubEnv(key, value);

      const pluginPath = cmd.ownedPaths![0]!;
      const mod = (await import(pathToFileURL(pluginPath).href)) as {
        KarstBridge: (ctx: {
          client: unknown;
          directory: string;
          worktree: string;
        }) => Promise<{ event(input: unknown): Promise<void> }>;
      };
      const promptAsync = vi.fn().mockResolvedValue({ data: {} });
      const bridge = await mod.KarstBridge({
        client: { session: { promptAsync } },
        directory: worktree,
        worktree,
      });

      await bridge.event({
        event: {
          type: 'session.idle',
          id: 'ev1',
          properties: { sessionID: 'ses_mail' },
        },
      });

      await until(() => promptAsync.mock.calls.length > 0);
      expect(promptAsync).toHaveBeenCalledWith({
        path: { id: 'ses_mail' },
        body: { parts: [{ type: 'text', text: 'karst: 1 new message(s) - run inbox' }] },
      });
    } finally {
      await endpoint.close();
    }
  });
});
