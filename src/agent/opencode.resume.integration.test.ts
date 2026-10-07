import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import {
  openRecoveryRound,
  recordFixLaunchIntent,
  listRecoveryRounds,
} from '../store/recoveryRounds.js';
import { getSessionLaunchIntent } from '../store/sessionLaunchIntents.js';
import { listProcessRuns } from '../store/processRuns.js';
import { startHookEndpoint } from '../hooks/endpoint.js';
import { KARST_RESUME_SESSION_ENV, OpencodeAdapter } from './opencode.js';

/**
 * The real-TUI experiment, reduced to a deterministic integration: a resumed
 * opencode launch (`--session`, no `--prompt`) must still (a) receive its
 * kickoff and (b) confirm its prepared launch intent through the hook channel.
 *
 * opencode 1.18.35 drops `--prompt` with `--session` and never emits
 * `session.created`, so the adapter writes the kickoff for the generated
 * plugin; the plugin pushes it through the SDK and posts SessionStart for the
 * resumed id. This test wires the REAL endpoint + store + dispatch to the REAL
 * generated plugin with a fake SDK client, and asserts the intent confirms and
 * the Fix process run opens.
 */
const T0 = '2026-08-01T10:00:00.000Z';

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc-resume-'));
  temporaryRoots.push(root);
  return root;
}

async function until(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before the timeout');
}

describe('opencode resumed launch — kickoff delivery + intent confirmation', () => {
  let store: Store;

  afterEach(() => store?.close());

  it('delivers the brief through the SDK and confirms the fix launch intent', async () => {
    store = openStore(':memory:');
    const worktree = makeWorktree();
    const ticket = createTicketFlow(store, { key: 'OC-RESUME', title: 'resume' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`,
      )
      .run(ticket.id, worktree);

    const round = openRecoveryRound(store, {
      ticketId: ticket.id,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
    });
    const launchId = 'a85263e8-9334-4506-bd76-e32ad19386eb';
    recordFixLaunchIntent(store, {
      ticketId: ticket.id,
      launchId,
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: round.id,
      at: T0,
    });

    const endpoint = await startHookEndpoint(store, 0);
    try {
      const configDir = join(worktree, '.karst-runtime');
      mkdirSync(configDir, { recursive: true });
      const cmd = new OpencodeAdapter().buildInteractiveCommand({
        cwd: worktree,
        hookChannel: {
          endpointUrl: `${endpoint.url}?karstLaunch=${launchId}`,
          configDir,
          launchId,
        },
        resume: 'ses_resumed',
        initialPrompt: 'FIX-BRIEF-TOKEN',
      });
      // The kickoff must NOT ride argv (opencode drops it with --session).
      expect(cmd.args).not.toContain('--prompt');
      expect(cmd.env[KARST_RESUME_SESSION_ENV]).toBe('ses_resumed');
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
      await mod.KarstBridge({
        client: { session: { promptAsync } },
        directory: worktree,
        worktree,
      });

      await until(
        () => getSessionLaunchIntent(store, launchId)?.status === 'confirmed',
      );

      const intent = getSessionLaunchIntent(store, launchId)!;
      expect(intent.status).toBe('confirmed');
      expect(intent.providerSessionId).toBe('ses_resumed');

      const fixRun = listProcessRuns(store, ticket.id).find(
        (run) => run.processId === 'fix',
      );
      expect(fixRun?.status).toBe('running');
      expect(listRecoveryRounds(store, ticket.id)[0]!.status).toBe('fixing');

      // The resumed session actually received its brief, through the SDK.
      expect(promptAsync).toHaveBeenCalledWith({
        path: { id: 'ses_resumed' },
        body: { parts: [{ type: 'text', text: 'FIX-BRIEF-TOKEN' }] },
      });
    } finally {
      await endpoint.close();
    }
  });
});
