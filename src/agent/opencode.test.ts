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
  it('declares truthful conservative capabilities and the opencode binary', () => {
    const a = new OpencodeAdapter();
    expect(a.requiredBinary).toBe('opencode');
    expect(a.capabilities).toEqual({
      lifecycleEvents: true,
      resume: false,
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

  it('drops sessionName (opencode TUI has no launch-time session-name flag)', () => {
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: '/wt',
      sessionName: 'Karst: KARST-1 — title',
      initialPrompt: 'go',
    });
    expect(cmd.args).not.toContain('--name');
    expect(cmd.args).not.toContain('Karst: KARST-1 — title');
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
    expect(body).toContain('session.idle');
    expect(body).toContain('session.error');
    expect(body).toContain('permission.asked');
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
 * `event` hook with captured opencode event fixtures. That is the proof the
 * plugin actually posts UsageUpdate: a session.idle carrying the session's
 * cumulative tokens produces one lifecycle POST and one usage POST, and a
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

  it('posts a UsageUpdate with the session’s cumulative tokens on a token-bearing session.idle', async () => {
    const worktree = makeWorktree();
    const r = await receiver(2);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-1',
          type: 'session.idle',
          properties: {
            sessionID: 'ses_1',
            cwd: '/wt',
            reason: 'step-finish',
            session: {
              id: 'ses_1',
              tokens: {
                total: 16_318,
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
        { hook_event_name: 'session.idle', cwd: '/wt', session_id: 'ses_1' },
        {
          hook_event_name: 'UsageUpdate',
          cwd: '/wt',
          session_id: 'ses_1',
          usage: {
            event_id: 'evt-1',
            input: 16_312,
            output: 6,
            cache_read: 180,
            cache_write: 40,
            total: 16_318,
          },
        },
      ]);
    } finally {
      await r.close();
    }
  });

  it('posts only the lifecycle event when the idle event carries no tokens', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-2',
          type: 'session.idle',
          properties: { sessionID: 'ses_1', cwd: '/wt', reason: 'manual' },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no lifecycle payload')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        { hook_event_name: 'session.idle', cwd: '/wt', session_id: 'ses_1' },
      ]);
    } finally {
      await r.close();
    }
  });

  it('drops malformed token counts — the lifecycle event still posts, no UsageUpdate', async () => {
    const worktree = makeWorktree();
    const r = await receiver(1);
    try {
      const bridge = await loadBridge(worktree, r.endpointUrl);
      await bridge.event({
        event: {
          id: 'evt-3',
          type: 'session.idle',
          properties: {
            sessionID: 'ses_1',
            cwd: '/wt',
            session: { id: 'ses_1', tokens: { input: 'lots', output: 6 } },
          },
        },
      });
      const bodies = await Promise.race([
        r.received,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('plugin posted no lifecycle payload')), 2_000),
        ),
      ]);
      expect(bodies).toEqual([
        { hook_event_name: 'session.idle', cwd: '/wt', session_id: 'ses_1' },
      ]);
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
});

describe('parseOpencodeJsonl', () => {
  it('returns the session id, last text, and mapped token usage', () => {
    const { sessionId, raw, usage } = parseOpencodeJsonl(okNdjson);
    expect(sessionId).toBe('ses_abc');
    expect(raw).toBe('HELLO');
    expect(usage).toEqual({
      inputTokens: 16312, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0,
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
  it('runs a fresh NDJSON run with --auto under bypassPermissions', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    const result = await new OpencodeAdapter(spawn).runHeadless({
      cwd: '/wt', prompt: '- inspect', permissionMode: 'bypassPermissions', model: 'openrouter/~openai/gpt-mini-latest',
    });
    expect(spawn).toHaveBeenCalledWith('opencode', ['run', '--format', 'json', '--pure', '--auto', '--model', 'openrouter/~openai/gpt-mini-latest', '--', '- inspect'], '/wt');
    expect(result).toEqual({ sessionId: 'ses_abc', verdict: null, raw: 'HELLO', usage: expect.objectContaining({ inputTokens: 16312 }) });
  });

  it('runs without --auto when permissionMode is not bypass', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    await new OpencodeAdapter(spawn).runHeadless({ cwd: '/wt', prompt: 'go' });
    expect(spawn.mock.calls[0]![1]).not.toContain('--auto');
  });

  it('runs a resumed headless run via --session', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    await new OpencodeAdapter(spawn).runHeadless({ cwd: '/wt', prompt: 'continue', resume: 'ses_abc' });
    expect(spawn).toHaveBeenCalledWith('opencode', ['run', '--format', 'json', '--pure', '--session', 'ses_abc', '--', 'continue'], '/wt');
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
