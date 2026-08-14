import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { OpencodeAdapter, parseOpencodeJsonl, type SpawnHeadless } from './opencode.js';
import { cleanupOwnedPaths } from './materializedCleanup.js';

const okNdjson = [
  JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_abc', part: { id: 'p1', messageID: 'm1', sessionID: 'ses_abc', type: 'step-start' } }),
  JSON.stringify({ type: 'text', timestamp: 2, sessionID: 'ses_abc', part: { id: 'p2', type: 'text', text: 'HELLO', time: { start: 1, end: 2 } } }),
  JSON.stringify({ type: 'step_finish', timestamp: 3, sessionID: 'ses_abc', part: { id: 'p3', reason: 'stop', type: 'step-finish', tokens: { total: 16318, input: 16312, output: 6, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0.012261 } }),
].join('\n');

function fakeSpawn(r: { stdout: string; stderr?: string; exitCode: number }): SpawnHeadless {
  return async () => ({ stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode });
}

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc-worktree-'));
  temporaryRoots.push(root);
  return root;
}

function makeBasePackage(
  id: string,
  files: readonly (readonly [string, string])[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc-package-'));
  temporaryRoots.push(root);
  for (const [relativePath, body] of files) {
    const path = join(root, id, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

describe('OpencodeAdapter capabilities', () => {
  it('declares truthful capabilities and the opencode binary', () => {
    const a = new OpencodeAdapter();
    expect(a.requiredBinary).toBe('opencode');
    expect(a.capabilities).toEqual({
      lifecycleEvents: true,
      resume: true,
      interactiveUsage: true,
    });
  });
});

describe('OpencodeAdapter interactive commands', () => {
  it('builds a fresh interactive launch that prefills the prompt', () => {
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: '/wt',
      model: 'openrouter/~openai/gpt-mini-latest',
      initialPrompt: '/rpi KARST-1',
    });
    expect(cmd.command).toBe('opencode');
    expect(cmd.args).toEqual(['--model', 'openrouter/~openai/gpt-mini-latest', '--prompt', '/rpi KARST-1']);
    expect(cmd.env).toEqual({});
  });

  it('drops an effort for the interactive TUI (opencode TUI has no --variant flag)', () => {
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: '/wt',
      model: 'openrouter/~openai/gpt-mini-latest',
      effort: 'high',
      initialPrompt: '/rpi KARST-1',
    });
    expect(cmd.command).toBe('opencode');
    expect(cmd.args).toEqual([
      '--model',
      'openrouter/~openai/gpt-mini-latest',
      '--prompt',
      '/rpi KARST-1',
    ]);
  });

  it('drops sessionName (opencode TUI has no launch-time session-name flag)', () => {
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: '/wt',
      sessionName: 'Karst: KARST-1 — title',
      initialPrompt: 'go',
    });
    expect(cmd.args).not.toContain('--name');
    expect(cmd.args).not.toContain('Karst: KARST-1 — title');
  });

  it('threads a captured session id as --session on a resumed launch', () => {
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: '/wt',
      resume: 'ses_abc',
      initialPrompt: 'go',
    });
    expect(cmd.args).toEqual(['--session', 'ses_abc', '--prompt', 'go']);
  });

  it('places extraArgs before the prompt', () => {
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: '/wt',
      extraArgs: ['--agent', 'build'],
      initialPrompt: 'go',
    });
    expect(cmd.args).toEqual(['--agent', 'build', '--prompt', 'go']);
  });

  it('materializes a karst-bridge plugin that POSTs session.idle/permission.asked to the hook endpoint', () => {
    const worktree = makeWorktree();
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(configDir, { recursive: true });
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: worktree,
      hookChannel: { endpointUrl: 'http://127.0.0.1:4567/hooks', configDir },
      initialPrompt: 'go',
    });
    const pluginPath = join(worktree, '.opencode', 'plugins', 'karst-bridge.js');
    expect(existsSync(pluginPath)).toBe(true);
    const body = readFileSync(pluginPath, 'utf8');
    expect(body).toContain('session.created');
    expect(body).toContain('session.updated');
    expect(body).toContain('session.idle');
    expect(body).toContain('session.error');
    expect(body).toContain('permission.asked');
    expect(body).toContain('permission.replied');
    expect(body).toContain('session.status');
    expect(body).toContain('http://127.0.0.1:4567/hooks');
    // `--pure` disables ALL external plugin loading in opencode — including the
    // auto-discovered `.opencode/plugins/karst-bridge.js` written just above —
    // so an interactive session launched with it can never deliver a hook event
    // (no SessionStart, no permission.asked, no usage). That is how a permission
    // ask in an opencode fix session failed to surface "Needs you" (869eg458d).
    // The flag must never be passed on an interactive launch.
    expect(cmd.args).not.toContain('--pure');
    expect(cmd.ownedPaths).toEqual([pluginPath]);
  });

  it('generated bridge keeps cache reads and cache writes as separate counters in the usage payload', () => {
    const worktree = makeWorktree();
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(configDir, { recursive: true });
    new OpencodeAdapter().buildInteractiveCommand({
      cwd: worktree,
      hookChannel: { endpointUrl: 'http://127.0.0.1:4567/hooks', configDir },
      initialPrompt: 'go',
    });
    const body = readFileSync(join(worktree, '.opencode', 'plugins', 'karst-bridge.js'), 'utf8');
    expect(body).toContain("'UsageUpdate'");
    // The opencode token shape nests cache under `cache: { read, write }`; the
    // bridge must read each separately and emit `cache_read`/`cache_write`.
    expect(body).toContain('cache.read');
    expect(body).toContain('cache.write');
    expect(body).toContain('cache_read');
    expect(body).toContain('cache_write');
    expect(body).not.toContain('cached_input');
  });

  it('writes no plugin and adds no --pure when hookChannel is absent', () => {
    const worktree = makeWorktree();
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: worktree,
      initialPrompt: 'go',
    });
    expect(existsSync(join(worktree, '.opencode', 'plugins', 'karst-bridge.js'))).toBe(false);
    expect(cmd.args).not.toContain('--pure');
    expect(cmd.ownedPaths).toBeUndefined();
  });

  it('refuses a non-loopback hook endpoint', () => {
    const worktree = makeWorktree();
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(configDir, { recursive: true });
    expect(() =>
      new OpencodeAdapter().buildInteractiveCommand({
        cwd: worktree,
        hookChannel: { endpointUrl: 'https://example.com/hooks', configDir },
        initialPrompt: 'go',
      }),
    ).toThrow(/loopback/i);
  });

  it('does not overwrite an identical plugin across launches (atomic write)', () => {
    const worktree = makeWorktree();
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(configDir, { recursive: true });
    const opts = {
      cwd: worktree,
      hookChannel: { endpointUrl: 'http://127.0.0.1:4567/hooks', configDir },
      initialPrompt: 'go',
    };
    new OpencodeAdapter().buildInteractiveCommand(opts);
    const pluginPath = join(worktree, '.opencode', 'plugins', 'karst-bridge.js');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(pluginPath, old, old);
    new OpencodeAdapter().buildInteractiveCommand(opts);
    expect(statSync(pluginPath).mtimeMs).toBe(old.getTime());
  });

  it('cleanupOwnedPaths removes the generated karst-bridge plugin', () => {
    const worktree = makeWorktree();
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(configDir, { recursive: true });
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: worktree,
      hookChannel: { endpointUrl: 'http://127.0.0.1:4567/hooks', configDir },
      initialPrompt: 'go',
    });
    cleanupOwnedPaths(worktree, cmd.ownedPaths ?? []);
    expect(existsSync(join(worktree, '.opencode', 'plugins', 'karst-bridge.js'))).toBe(false);
  });
});

/**
 * The generated bridge runs under Bun inside the opencode server, but it is a
 * plain ESM module — so vitest can import the generated file and drive its
 * `event` hook with REAL opencode event shapes (verified against the installed
 * 1.18.18 CLI source and a live conversation DB). opencode 1.18.18 emits
 * `session.idle` with only a `sessionID` — the cumulative token tally rides
 * `session.updated`'s `properties.info.tokens` (per-step `part.tokens` on
 * `message.part.updated` is deliberately NOT read: the ledger compares
 * cumulative tallies, and a step-local count would read as a counter reset).
 * The tests prove the plugin actually posts UsageUpdate: a session.updated
 * carrying the session's cumulative tokens produces a usage POST, and a
 * token-less or malformed event produces no usage POST at all.
 */
describe('generated karst-bridge plugin — UsageUpdate', () => {
  function receiver(count: number): Promise<{
    endpointUrl: string;
    received: Promise<unknown[]>;
    close(): Promise<void>;
  }> {
    const bodies: unknown[] = [];
    let resolveAll!: (b: unknown[]) => void;
    const received = new Promise<unknown[]>((resolve) => {
      resolveAll = resolve;
    });
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        if (bodies.length >= count) resolveAll(bodies);
        response.writeHead(204);
        response.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address !== 'object' || address === null) {
          reject(new Error('hook receiver did not bind a TCP port'));
          return;
        }
        resolve({
          endpointUrl: `http://127.0.0.1:${address.port}/hooks`,
          received,
          close: () =>
            new Promise<void>((closeResolve, closeReject) => {
              server.close((error) => {
                if (error) closeReject(error);
                else closeResolve();
              });
            }),
        });
      });
    });
  }

  async function loadBridge(worktree: string, endpointUrl: string): Promise<{
    event(input: unknown): Promise<void>;
  }> {
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(configDir, { recursive: true });
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: worktree,
      hookChannel: { endpointUrl, configDir },
      initialPrompt: 'go',
    });
    const pluginPath = cmd.ownedPaths![0]!;
    const mod = (await import(pathToFileURL(pluginPath).href)) as {
      KarstBridge: (ctx: { directory: string; worktree: string }) => Promise<{
        event(input: unknown): Promise<void>;
      }>;
    };
    return mod.KarstBridge({ directory: worktree, worktree });
  }

  it('posts a UsageUpdate with the session’s cumulative tokens on a token-bearing session.updated', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-1',
          type: 'session.updated',
          properties: {
            sessionID: 'ses_1',
            info: {
              id: 'ses_1',
              directory: '/wt',
              tokens: {
                input: 16_312,
                output: 6,
                reasoning: 0,
                cache: { write: 40, read: 180 },
              },
            },
          },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no usage payload')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        {
          hook_event_name: 'UsageUpdate',
          cwd: '/wt',
          session_id: 'ses_1',
          usage: {
            event_id: 'evt-1',
            input: 16_312,
            output: 6,
            reasoning: 0,
            cache_read: 180,
            cache_write: 40,
          },
        },
      ]);
    } finally {
      await r.close();
    }
  });

  it('carries the reasoning counter — output-billed thinking is not free', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-r',
          type: 'session.updated',
          properties: {
            sessionID: 'ses_r',
            info: {
              id: 'ses_r',
              directory: '/wt',
              tokens: {
                input: 100,
                output: 8_220,
                reasoning: 40_485,
                cache: { write: 0, read: 5_527_808 },
              },
            },
          },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no usage payload')), 2_000),
        ),
      ]);
      expect((bodies as { usage: unknown }[])[0]!.usage).toEqual({
        event_id: 'evt-r',
        input: 100,
        output: 8_220,
        reasoning: 40_485,
        cache_read: 5_527_808,
        cache_write: 0,
      });
    } finally {
      await r.close();
    }
  });

  it('re-posts only when ONLY the reasoning counter advanced', async () => {
    const worktree = makeWorktree();
    const r = await receiver(2);
    const tokens = (reasoning: number) => ({
      input: 100,
      output: 10,
      reasoning,
      cache: { write: 0, read: 0 },
    });
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      for (const [id, reasoning] of [['evt-a', 400], ['evt-b', 900]] as const) {
        await bridge.event({
          event: {
            id,
            type: 'session.updated',
            properties: {
              sessionID: 'ses_x',
              info: { id: 'ses_x', directory: '/wt', tokens: tokens(reasoning) },
            },
          },
        });
      }
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no usage payload')), 2_000),
        ),
      ]);
      expect(
        (bodies as { usage: { reasoning: number } }[]).map((b) => b.usage.reasoning),
      ).toEqual([400, 900]);
    } finally {
      await r.close();
    }
  });

  it('re-posts only when the cumulative tally advanced — an unchanged session.updated stays silent', async () => {
    const worktree = makeWorktree();
    const r = await receiver(2);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      const updated = (id: string, input: number) => ({
        event: {
          id,
          type: 'session.updated',
          properties: {
            sessionID: 'ses_1',
            info: {
              id: 'ses_1',
              directory: '/wt',
              tokens: { input, output: 6, reasoning: 0, cache: { write: 40, read: 180 } },
            },
          },
        },
      });
      await bridge.event(updated('evt-1', 16_312));
      // Same tally, new event id — the ledger must not see a zero delta, so no
      // UsageUpdate may be posted for it.
      await bridge.event(updated('evt-2', 16_312));
      // Advanced tally — a new UsageUpdate must land.
      await bridge.event(updated('evt-3', 17_000));
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no advanced usage')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        {
          hook_event_name: 'UsageUpdate',
          cwd: '/wt',
          session_id: 'ses_1',
          usage: {
            event_id: 'evt-1',
            input: 16_312,
            output: 6,
            reasoning: 0,
            cache_read: 180,
            cache_write: 40,
          },
        },
        {
          hook_event_name: 'UsageUpdate',
          cwd: '/wt',
          session_id: 'ses_1',
          usage: {
            event_id: 'evt-3',
            input: 17_000,
            output: 6,
            reasoning: 0,
            cache_read: 180,
            cache_write: 40,
          },
        },
      ]);
    } finally {
      await r.close();
    }
  });

  it('posts no usage when the idle event carries no tokens — session.idle is lifecycle-only', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-2',
          type: 'session.idle',
          properties: { sessionID: 'ses_1' },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no lifecycle payload')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        { hook_event_name: 'session.idle', cwd: worktree, session_id: 'ses_1' },
      ]);
    } finally {
      await r.close();
    }
  });

  it('drops malformed token counts — the session.updated lifecycle posts nothing, no UsageUpdate', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-3',
          type: 'session.updated',
          properties: {
            sessionID: 'ses_1',
            info: {
              id: 'ses_1',
              directory: '/wt',
              tokens: { input: 'lots', output: 6 },
            },
          },
        },
      });
      await expect(Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no posts within 150ms')), 150),
        ),
      ])).rejects.toThrow('no posts within 150ms');
    } finally {
      await r.close();
    }
  });

  it('permission.asked posts no usage — it is a wait signal, not a completion', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-4',
          type: 'permission.asked',
          properties: { sessionID: 'ses_1', cwd: '/wt' },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no lifecycle payload')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        { hook_event_name: 'permission.asked', cwd: '/wt', session_id: 'ses_1' },
      ]);
    } finally {
      await r.close();
    }
  });

  it.each(['question.asked', 'question.v2.asked'])(
    'posts permission.asked for %s — a question is the same wait signal',
    async (type) => {
      const worktree = makeWorktree();
      const r = await receiver(1);
      try {
        const bridge = await loadBridge(worktree, r.endpointUrl);
        await bridge.event({
          event: {
            id: `evt-${type}`,
            type,
            properties: { sessionID: 'ses_1', cwd: '/wt' },
          },
        });
        const bodies = await Promise.race([
          r.received,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('plugin posted no lifecycle payload')), 2_000),
          ),
        ]);
        expect(bodies).toEqual([
          { hook_event_name: 'permission.asked', cwd: '/wt', session_id: 'ses_1' },
        ]);
      } finally {
        await r.close();
      }
    },
  );

  // opencode never posts a PostToolUse/UserPromptSubmit, so the resolution of
  // an ask is the ONLY signal that the session is working again — without it
  // one answered permission left the ticket amber for the whole remaining turn.
  it.each(['permission.replied', 'permission.v2.replied', 'question.replied', 'question.v2.replied'])(
    'posts permission.replied for %s — resolution of the wait flips the amber off',
    async (type) => {
      const worktree = makeWorktree();
      const r = await receiver(1);
      try {
        const bridge = await loadBridge(worktree, r.endpointUrl);
        await bridge.event({
          event: {
            id: `evt-${type}`,
            type,
            properties: { sessionID: 'ses_1', cwd: '/wt' },
          },
        });
        const bodies = await Promise.race([
          r.received,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('plugin posted no lifecycle payload')), 2_000),
          ),
        ]);
        expect(bodies).toEqual([
          { hook_event_name: 'permission.replied', cwd: '/wt', session_id: 'ses_1' },
        ]);
      } finally {
        await r.close();
      }
    },
  );

  it('posts session.status with the status type when the session is busy (processing resumed)', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-status',
          type: 'session.status',
          properties: { sessionID: 'ses_1', cwd: '/wt', status: { type: 'busy' } },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no lifecycle payload')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        { hook_event_name: 'session.status', cwd: '/wt', session_id: 'ses_1', message: 'busy' },
      ]);
    } finally {
      await r.close();
    }
  });

  it('posts nothing for session.status idle — session.idle owns the idle signal', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-status-idle',
          type: 'session.status',
          properties: { sessionID: 'ses_1', cwd: '/wt', status: { type: 'idle' } },
        },
      });
      await expect(Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no posts within 150ms')), 150),
        ),
      ])).rejects.toThrow('no posts within 150ms');
    } finally {
      await r.close();
    }
  });

  // opencode's launch-intent handshake is confirmed ONLY by a SessionStart
  // carrying the launch id (dispatch.ts), and the plugin is opencode's entire
  // hook channel — so the session's creation event MUST normalize to
  // SessionStart, exactly as agy's conversation watch synthesizes one. Without
  // it, a closed-session fix launch (no live session to nudge) records its
  // intent and then waits forever: the round stays `pending`, never `fixing`,
  // and the stranded-fix sweep parks the stage "no fix execution in flight"
  // while the agent is actually working (REVIEW-2ND-ROUND-FIX-STUCK-WITH).
  it('posts SessionStart for session.created — the launch-intent confirmation opencode would otherwise never send', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-created',
          type: 'session.created',
          properties: {
            info: {
              id: 'ses_new',
              projectID: 'proj-1',
              directory: '/wt',
              title: 'fix',
              version: '1',
              time: { created: 1, updated: 1 },
            },
          },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no SessionStart')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        { hook_event_name: 'SessionStart', cwd: '/wt', session_id: 'ses_new' },
      ]);
    } finally {
      await r.close();
    }
  });
});

describe('generated karst-bridge plugin — SessionStart capture', () => {
  function receiver(): Promise<{
    endpointUrl: string;
    received: Promise<unknown[]>;
    close(): Promise<void>;
  }> {
    const bodies: unknown[] = [];
    let resolveAll!: (b: unknown[]) => void;
    const received = new Promise<unknown[]>((resolve) => {
      resolveAll = resolve;
    });
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        resolveAll(bodies);
        response.writeHead(204);
        response.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address !== 'object' || address === null) {
          reject(new Error('hook receiver did not bind a TCP port'));
          return;
        }
        resolve({
          endpointUrl: `http://127.0.0.1:${address.port}/hooks`,
          received,
          close: () =>
            new Promise<void>((closeResolve, closeReject) => {
              server.close((error) => {
                if (error) closeReject(error);
                else closeResolve();
              });
            }),
        });
      });
    });
  }

  async function loadBridge(worktree: string, endpointUrl: string): Promise<{
    event(input: unknown): Promise<void>;
  }> {
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(configDir, { recursive: true });
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: worktree,
      hookChannel: { endpointUrl, configDir },
      initialPrompt: 'go',
    });
    const pluginPath = cmd.ownedPaths![0]!;
    const mod = (await import(pathToFileURL(pluginPath).href)) as {
      KarstBridge: (ctx: { directory: string; worktree: string }) => Promise<{
        event(input: unknown): Promise<void>;
      }>;
    };
    return mod.KarstBridge({ directory: worktree, worktree });
  }

  // The resume-by-id contract (§5.3) needs the interactive session id captured
  // while a session runs. opencode delivers it ONLY at creation
  // (`EventSessionCreated` carries `properties.info: Session` with `id` and
  // `directory`), so the bridge must POST `SessionStart` on `session.created`
  // — without it `tickets.session_id` stays NULL and the sidebar button can
  // never `--session` the previous conversation (investigation #217).
  it('posts SessionStart on session.created, reading id/directory from properties.info', async () => {
    const worktree = makeWorktree();
    const r = await receiver();
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-created',
          type: 'session.created',
          properties: {
            info: { id: 'ses_created', directory: '/wt' },
          },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no SessionStart')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        { hook_event_name: 'SessionStart', cwd: '/wt', session_id: 'ses_created' },
      ]);
    } finally {
      await r.close();
    }
  });

  it('drops a session.created without an id — nothing to capture', async () => {
    const worktree = makeWorktree();
    const r = await receiver();
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-created-none',
          type: 'session.created',
          properties: { info: { directory: '/wt' } },
        },
      });
      await expect(Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no posts within 150ms')), 150),
        ),
      ])).rejects.toThrow('no posts within 150ms');
    } finally {
      await r.close();
    }
  });
});

describe('parseOpencodeJsonl', () => {
  it('returns the session id, last text, and mapped token usage', () => {
    const { sessionId, raw, usage } = parseOpencodeJsonl(okNdjson);
    expect(sessionId).toBe('ses_abc');
    expect(raw).toBe('HELLO');
    expect(usage).toEqual({
      inputTokens: 16312, outputTokens: 6, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 16318, model: null, estimated: false,
    });
  });

  it('concatenates multiple text parts in order', () => {
    const nd = [
      JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', timestamp: 2, sessionID: 'ses_x', part: { type: 'text', text: 'a' } }),
      JSON.stringify({ type: 'text', timestamp: 3, sessionID: 'ses_x', part: { type: 'text', text: 'b' } }),
      JSON.stringify({ type: 'step_finish', timestamp: 4, sessionID: 'ses_x', part: { type: 'step-finish', tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } } } }),
    ].join('\n');
    expect(parseOpencodeJsonl(nd).raw).toBe('ab');
  });

  it.each([
    ['error event', JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'ses_e', error: { name: 'UnknownError', data: { message: 'boom' } } })],
    ['missing session', JSON.stringify({ type: 'step_start', timestamp: 1, part: { type: 'step-start' } })],
    ['no text', [JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } }), JSON.stringify({ type: 'step_finish', timestamp: 2, sessionID: 's', part: { type: 'step-finish', tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } } } })].join('\n')],
  ])('rejects %s', (_label, stdout) => {
    expect(() => parseOpencodeJsonl(stdout)).toThrow();
  });

  it('skips unparseable trailing lines without failing', () => {
    const nd = okNdjson + '\n{truncated';
    expect(parseOpencodeJsonl(nd).sessionId).toBe('ses_abc');
  });
});

describe('OpencodeAdapter headless execution', () => {
  it('forwards the abort signal into the headless spawn', async () => {
    let seenOpts: { signal?: AbortSignal } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: okNdjson, stderr: '', exitCode: 0 };
    };
    const adapter = new OpencodeAdapter(spawn);
    const controller = new AbortController();
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt/a', signal: controller.signal });
    expect(seenOpts?.signal).toBe(controller.signal);
  });

  it('forwards the headless deadline into the spawn', async () => {
    let seenOpts: { timeoutMs?: number } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: okNdjson, stderr: '', exitCode: 0 };
    };
    await new OpencodeAdapter(spawn).runHeadless({
      prompt: 'go',
      cwd: '/wt/a',
      timeoutMs: 123_456,
    });
    expect(seenOpts?.timeoutMs).toBe(123_456);
  });

  it('runs a fresh NDJSON run with --auto under bypassPermissions', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    const result = await new OpencodeAdapter(spawn).runHeadless({
      cwd: '/wt', prompt: '- inspect', permissionMode: 'bypassPermissions', model: 'openrouter/~openai/gpt-mini-latest',
    });
    expect(spawn).toHaveBeenCalledWith('opencode', ['run', '--format', 'json', '--pure', '--auto', '--model', 'openrouter/~openai/gpt-mini-latest', '--', '- inspect'], '/wt', { signal: undefined });
    expect(result).toEqual({ sessionId: 'ses_abc', verdict: null, raw: 'HELLO', usage: expect.objectContaining({ inputTokens: 16312 }) });
  });

  it('threads an effort as --variant into a headless run', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    await new OpencodeAdapter(spawn).runHeadless({
      cwd: '/wt', prompt: '- inspect', model: 'openrouter/~openai/gpt-mini-latest', effort: 'high',
    });
    expect(spawn.mock.calls[0]![1]).toContain('--variant');
    expect(spawn.mock.calls[0]![1][spawn.mock.calls[0]![1].indexOf('--variant') + 1]).toBe('high');
  });

  it('runs without --auto when permissionMode is not bypass', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    await new OpencodeAdapter(spawn).runHeadless({ cwd: '/wt', prompt: 'go' });
    expect(spawn.mock.calls[0]![1]).not.toContain('--auto');
  });

  it('renders the JSONL console stream into readable lines before the caller sees it', async () => {
    let seenOpts: { onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: okNdjson, stderr: '', exitCode: 0 };
    };
    const rendered: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    await new OpencodeAdapter(spawn).runHeadless({
      prompt: 'go',
      cwd: '/wt/a',
      onOutput: (chunk) => rendered.push(chunk),
    });
    // A bash tool_use event arrives as `$ <command>` + output, never raw JSON.
    seenOpts?.onOutput?.({
      stream: 'stdout',
      text:
        JSON.stringify({
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'git status' }, output: 'clean\n' },
          },
        }) + '\n',
    });
    expect(rendered).toEqual([{ stream: 'stdout', text: '$ git status\nclean\n' }]);
  });

  it('runs a resumed headless run via --session', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    await new OpencodeAdapter(spawn).runHeadless({ cwd: '/wt', prompt: 'continue', resume: 'ses_abc' });
    expect(spawn).toHaveBeenCalledWith('opencode', ['run', '--format', 'json', '--pure', '--session', 'ses_abc', '--', 'continue'], '/wt', { signal: undefined });
  });

  it('reports bounded diagnostics + usage on a nonzero exit', async () => {
    const errNd = JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'ses_e', error: { name: 'UnknownError', data: { message: 'x'.repeat(20_000) } } });
    const adapter = new OpencodeAdapter(fakeSpawn({ stdout: errNd, stderr: '', exitCode: 1 }));
    await expect(adapter.runHeadless({ cwd: '/wt', prompt: 'go' })).rejects.toThrow(/opencode/i);
  });
});

describe('OpencodeAdapter approach materialization', () => {
  it('preserves a skill folder and rewrites its name frontmatter', () => {
    const baseDir = makeBasePackage('rpi', [
      ['skills/planning/SKILL.md', '---\nname: planning\ndescription: Plan.\n---\nPlan.'],
      ['skills/planning/references/checks.md', '# checks'],
    ]);
    const worktree = makeWorktree();
    new OpencodeAdapter().materializeApproach!({
      baseDir,
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'RPI', artifacts: [{ kind: 'skill', relPath: 'skills/planning/SKILL.md' }] },
    });
    expect(readFileSync(join(worktree, '.opencode/skills/karst-rpi-planning/references/checks.md'), 'utf8')).toBe('# checks');
    expect(readFileSync(join(worktree, '.opencode/skills/karst-rpi-planning/SKILL.md'), 'utf8')).toContain('name: karst-rpi-planning');
  });

  it('writes an agent artifact as a subagent markdown file', () => {
    const baseDir = makeBasePackage('rpi', [['agents/researcher.md', '# Researcher']]);
    const worktree = makeWorktree();
    new OpencodeAdapter().materializeApproach!({
      baseDir,
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'RPI', artifacts: [{ kind: 'agent', relPath: 'agents/researcher.md' }] },
    });
    const body = readFileSync(join(worktree, '.opencode/agents/karst-rpi-researcher.md'), 'utf8');
    expect(body).toContain('mode: subagent');
    expect(body).toContain('Delegate');
  });

  it('translates a command artifact to an on-demand skill', () => {
    const baseDir = makeBasePackage('rpi', [['commands/review.md', '# Review']]);
    const worktree = makeWorktree();
    new OpencodeAdapter().materializeApproach!({
      baseDir,
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'RPI', artifacts: [{ kind: 'command', relPath: 'commands/review.md' }] },
    });
    expect(existsSync(join(worktree, '.opencode/skills/karst-rpi-review/SKILL.md'))).toBe(true);
    expect(existsSync(join(worktree, '.opencode/commands/review.md'))).toBe(false);
  });

  it('generates a workflow command and native /<id> invocation', () => {
    const worktree = makeWorktree();
    const result = new OpencodeAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', []),
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'Research, Plan, Implement', workflow: [{ name: 'research' }, { name: 'plan' }] },
      cliContextPrefix: 'node cli.js context --ticket',
      cliStagePrefix: 'node cli.js stage impl pass --ticket',
      cliPhasePrefix: (n) => `node cli.js phase ${n} --ticket`,
    });
    expect(result.invocation).toBe('/rpi');
    const body = readFileSync(join(worktree, '.opencode/commands/rpi.md'), 'utf8');
    expect(body).toContain('node cli.js context --ticket $ARGUMENTS');
    expect(body).toContain('node cli.js phase research --ticket $ARGUMENTS');
    expect(body).toContain('node cli.js stage impl pass --ticket $ARGUMENTS');
  });

  it('materializes a solo agent into .opencode/agents/', () => {
    const worktree = makeWorktree();
    new OpencodeAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', []),
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'RPI' },
      soloAgent: { name: 'pm', body: 'do the work' },
    });
    expect(readFileSync(join(worktree, '.opencode/agents/karst-agent-pm.md'), 'utf8')).toContain('mode: subagent');
  });

  it.each(['../escape', '/absolute', 'karst', 'a/b', '!!!', ''])(
    'rejects unsafe/reserved/unsluggable id %s',
    (id) => {
      expect(() =>
        new OpencodeAdapter().materializeApproach!({
          baseDir: '/base',
          sessionDir: makeWorktree(),
          pkg: { id, label: id, workflow: [{ name: 'run' }] },
        }),
      ).toThrow(/unsafe|reserved|invalid|name/i);
    },
  );

  // A namespaced approach id (`superpowers:writing-plans`) is legal everywhere
  // karst stores one — the manifest, the package directory — and only the
  // basename opencode DISCOVERS under `.opencode/` has to be kebab. Rejecting
  // the id parked every ticket on that approach with no artifacts at all.
  it.each([
    ['superpowers:writing-plans', 'superpowers-writing-plans'],
    ['UPPER', 'upper'],
    ['dots.and_underscores', 'dots-and-underscores'],
  ])('slugs a non-kebab approach id %s into opencode-legal names', (id, slug) => {
    const worktree = makeWorktree();
    const result = new OpencodeAdapter().materializeApproach!({
      baseDir: makeBasePackage(id, [
        ['skills/planning/SKILL.md', '---\nname: planning\ndescription: Plan.\n---\nPlan.'],
      ]),
      sessionDir: worktree,
      pkg: {
        id,
        label: 'Writing Plans',
        artifacts: [{ kind: 'skill', relPath: 'skills/planning/SKILL.md' }],
        workflow: [{ name: 'plan' }],
      },
    });
    const skillDir = join(worktree, '.opencode/skills', `karst-${slug}-planning`);
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toContain(
      `name: karst-${slug}-planning`,
    );
    expect(existsSync(join(worktree, '.opencode/commands', `${slug}.md`))).toBe(true);
    expect(result.invocation).toBe(`/${slug}`);
    expect(result.ownedPaths).toEqual([skillDir]);
  });

  it('slugs a non-kebab artifact basename and solo agent name', () => {
    const worktree = makeWorktree();
    new OpencodeAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', [['agents/Deep_Researcher.md', '# Researcher']]),
      sessionDir: worktree,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [{ kind: 'agent', relPath: 'agents/Deep_Researcher.md' }],
      },
      soloAgent: { name: 'Product Manager', body: 'do the work' },
    });
    expect(existsSync(join(worktree, '.opencode/agents/karst-rpi-deep-researcher.md'))).toBe(true);
    expect(existsSync(join(worktree, '.opencode/agents/karst-agent-product-manager.md'))).toBe(true);
  });

  it('does not own a pre-existing .opencode tree (repo-owned, left alone)', () => {
    const worktree = makeWorktree();
    mkdirSync(join(worktree, '.opencode', 'skills', 'karst-rpi-planning'), { recursive: true });
    writeFileSync(join(worktree, '.opencode', 'skills', 'karst-rpi-planning', 'SKILL.md'), 'repo');
    const result = new OpencodeAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', [['skills/planning/SKILL.md', '---\nname: planning\ndescription: p\n---\n']]),
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'RPI', artifacts: [{ kind: 'skill', relPath: 'skills/planning/SKILL.md' }] },
    });
    expect(readFileSync(join(worktree, '.opencode/skills/karst-rpi-planning/SKILL.md'), 'utf8')).toBe('repo');
    expect(result.ownedPaths).toEqual([]);
  });
});

describe('generated karst-bridge plugin — endpoint rebind (869ej1zpv G3)', () => {
  function receiver(): Promise<{
    endpointUrl: string;
    received: Promise<unknown>;
    close(): Promise<void>;
  }> {
    let resolveBody!: (b: unknown) => void;
    const received = new Promise<unknown>((resolve) => {
      resolveBody = resolve;
    });
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        resolveBody(JSON.parse(body));
        response.writeHead(204);
        response.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address !== 'object' || address === null) {
          reject(new Error('hook receiver did not bind a TCP port'));
          return;
        }
        resolve({
          endpointUrl: `http://127.0.0.1:${address.port}/hooks`,
          received,
          close: () =>
            new Promise<void>((closeResolve, closeReject) => {
              server.close((error) => (error ? closeReject(error) : closeResolve()));
            }),
        });
      });
    });
  }

  // A VS Code reload rebinds an ephemeral hook port. Before this, an opencode
  // session that survived the reload POSTed into the dead launch-time port for
  // the rest of its life — the codex bridge had the fallback, its sibling did
  // not, which is the whole shape of this ticket.
  it('falls back to the extension’s current endpoint when the launch-time port is gone', async () => {
    const worktree = makeWorktree();
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(join(configDir, 'opencode'), { recursive: true });

    // A launch-time endpoint that binds (so the URL is legal) and is then closed.
    const dead = await receiver();
    const deadUrl = `${dead.endpointUrl}?karstLaunch=gen-7`;
    await dead.close();

    const live = await receiver();
    writeFileSync(join(configDir, 'opencode', 'current-endpoint'), live.endpointUrl);

    try {
      const cmd = new OpencodeAdapter().buildInteractiveCommand({
        cwd: worktree,
        hookChannel: { endpointUrl: deadUrl, configDir },
      });
      const mod = (await import(pathToFileURL(cmd.ownedPaths![0]!).href)) as {
        KarstBridge: (ctx: { directory: string; worktree: string }) => Promise<{
          event(input: unknown): Promise<void>;
        }>;
      };
      const bridge = await mod.KarstBridge({ directory: worktree, worktree });
      await bridge.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_1', directory: worktree } } },
      });
      expect(await live.received).toMatchObject({
        hook_event_name: 'SessionStart',
        session_id: 'ses_1',
      });
    } finally {
      await live.close();
    }
  });

  it('carries the launch generation onto the rebound endpoint', () => {
    const worktree = makeWorktree();
    const configDir = join(worktree, '.karst-runtime');
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: worktree,
      hookChannel: { endpointUrl: 'http://127.0.0.1:1/hooks?karstLaunch=gen-7', configDir },
    });
    const body = readFileSync(cmd.ownedPaths![0]!, 'utf8');
    // The generation rides the launch URL's query string and is re-applied to
    // every candidate, or the endpoint's generation barrier rejects the
    // rebound session.
    expect(body).toContain('launchSearch');
    expect(body).toContain(join(configDir, 'opencode', 'current-endpoint'));
  });
});

describe('generated karst-bridge plugin — fallback endpoint validation', () => {
  // Hook payloads carry session ids and worktree paths. The launch URL is
  // loopback-checked at generation time; the fallback arrives off disk at run
  // time, so it is re-checked in the bridge or a tampered file would exfiltrate
  // them. Same check now lives in the codex bridge.
  it('refuses a non-loopback fallback endpoint', async () => {
    const worktree = makeWorktree();
    const configDir = join(worktree, '.karst-runtime');
    mkdirSync(join(configDir, 'opencode'), { recursive: true });
    writeFileSync(
      join(configDir, 'opencode', 'current-endpoint'),
      'http://evil.example.com/hooks',
    );
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: worktree,
      // Port 1 is closed, so the launch candidate always fails and the fallback
      // is the only remaining one.
      hookChannel: { endpointUrl: 'http://127.0.0.1:1/hooks', configDir },
    });
    const mod = (await import(pathToFileURL(cmd.ownedPaths![0]!).href)) as {
      KarstBridge: (ctx: { directory: string; worktree: string }) => Promise<{
        event(input: unknown): Promise<void>;
      }>;
    };
    const bridge = await mod.KarstBridge({ directory: worktree, worktree });
    // Fails open (no throw), and the off-box candidate is never contacted.
    await expect(
      bridge.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 'ses_1', directory: worktree } },
        },
      }),
    ).resolves.toBeUndefined();
    const body = readFileSync(cmd.ownedPaths![0]!, 'utf8');
    expect(body).toContain('isLoopbackHost');
  });
});
