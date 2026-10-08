import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '../../manifest/fixtures.js';
import type { CreateTerminalOpts, SessionTerminal, TerminalHost } from '../../ui/session.js';
import { KARST_TERMINAL_ICON_ID } from '../../ui/terminalNaming.js';
import { hashInstructions } from '../../agent/instructions.js';
import { createSetupOps, type SetupOpsDeps } from './setupOps.js';

interface Recorded {
  opts: CreateTerminalOpts;
  shown: number;
  close?: (exitCode?: number) => void;
}

function fakeHost(): { host: TerminalHost; created: Recorded[] } {
  const created: Recorded[] = [];
  const host: TerminalHost = {
    createTerminal(opts): SessionTerminal {
      const rec: Recorded = { opts, shown: 0 };
      created.push(rec);
      return {
        show: () => void rec.shown++,
        sendText: () => undefined,
        dispose: () => rec.close?.(),
        onDidClose: (h) => void (rec.close = h),
      };
    },
  };
  return { host, created };
}

describe('setup ops', () => {
  let scratch: string;
  let created: Recorded[];
  let deps: SetupOpsDeps;
  const messages: string[] = [];
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-setup-'));
    const fake = fakeHost();
    created = fake.created;
    deps = {
      manifest: () => ({
        baselineBranch: 'main',
        repositories: { web: repo({ repoPath: '/src/web' }) },
      }),
      workspaceRoot: () => '/ws',
      defaultAgent: () => ({ provider: 'claude', model: 'opus' }),
      scratchDir: (id) => join(scratch, id),
      host: fake.host,
      cliEntry: () => '/dist/cli/main.js',
      dbPath: '/db/karst.db',
      manifestPath: () => '/ws/.karst/karst.yml',
      nextId: () => 'abc123',
      notify: { info: (m) => void messages.push(m), warn: (m) => void messages.push(m), error: async () => undefined },
    };
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('launches a read-only agent in the scratch dir with the setup env', async () => {
    const ops = createSetupOps(deps);
    expect(await ops.create()).toBe(true);
    const { opts } = created[0]!;
    expect(opts.cwd).toBe(join(scratch, 'abc123'));
    expect(opts.name).toBe('Sabc123 Workspace setup');
    expect(opts.iconPath).toBe(KARST_TERMINAL_ICON_ID);
    expect(opts.shellArgs).toEqual(expect.arrayContaining(['--disallowedTools', 'Edit']));
    const instructionsPath = opts.env!.KARST_INSTRUCTIONS!;
    expect(readFileSync(instructionsPath, 'utf8')).toContain('karst SETUP session');
    expect(opts.env).toEqual(expect.objectContaining({
      KARST_SETUP_SESSION: 'abc123',
      KARST_CLI: '/dist/cli/main.js',
      KARST_DB: '/db/karst.db',
      KARST_MANIFEST: '/ws/.karst/karst.yml',
      KARST_SETUP_OUTBOX: join(opts.cwd, 'outbox'),
    }));
    expect(existsSync(join(opts.cwd, 'outbox'))).toBe(true);
    expect(ops.isLive('abc123')).toBe(true);
    expect(created[0]!.shown).toBe(1);
  });

  it('adds the workspace root and every enabled repo as a readable dir', async () => {
    await createSetupOps(deps).create();
    const args = created[0]!.opts.shellArgs;
    expect(args).toEqual(expect.arrayContaining(['--add-dir', '/ws', '/src/web']));
  });

  it('gives a sandboxing core no writable root beyond the scratch cwd', async () => {
    await createSetupOps({ ...deps, defaultAgent: () => ({ provider: 'codex', model: null }) }).create();
    expect(created[0]!.opts.shellArgs).toContain('sandbox_workspace_write.writable_roots=[]');
  });

  it('launches with no manifest (greenfield) and still reads the workspace', async () => {
    const ops = createSetupOps({ ...deps, manifest: () => undefined });
    expect(await ops.create()).toBe(true);
    expect(created[0]!.opts.shellArgs).toEqual(expect.arrayContaining(['--add-dir', '/ws']));
  });

  it('asks before launching a core that cannot block edits and declines cleanly', async () => {
    const asked: string[] = [];
    const ops = createSetupOps({
      ...deps,
      defaultAgent: () => ({ provider: 'antigravity', model: null }),
      confirmUnsafeCore: async (core) => { asked.push(core); return false; },
    });
    expect(await ops.create()).toBe(false);
    expect(asked).toEqual(['antigravity']);
    expect(created).toHaveLength(0);
  });

  it('launches an unsafe core once the user acknowledges', async () => {
    const ops = createSetupOps({
      ...deps,
      defaultAgent: () => ({ provider: 'antigravity', model: null }),
      confirmUnsafeCore: async () => true,
    });
    expect(await ops.create()).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('warns instead of throwing when the terminal cannot be created', async () => {
    const debugs: string[] = [];
    const ops = createSetupOps({
      ...deps,
      debug: (m) => void debugs.push(m),
      host: { createTerminal: () => { throw new Error('pty gone'); } },
    });
    expect(await ops.create()).toBe(false);
    expect(messages.at(-1)).toMatch(/could not start/i);
    expect(debugs.some((m) => m.includes('pty gone'))).toBe(true);
  });

  it('forgets a terminal when it closes', async () => {
    const ops = createSetupOps(deps);
    await ops.create();
    created[0]!.close?.(0);
    expect(ops.isLive('abc123')).toBe(false);
  });

  it('generates a random id when no id source is injected', async () => {
    const ops = createSetupOps({ ...deps, nextId: undefined });
    expect(await ops.create()).toBe(true);
    const name = created[0]!.opts.name;
    expect(name).toMatch(/^S[0-9a-f]{8} Workspace setup$/);
    expect(ops.isLive(name.slice(1, 9))).toBe(true);
  });

  it('passes the resolved model to the launch', async () => {
    await createSetupOps(deps).create();
    expect(created[0]!.opts.shellArgs).toEqual(expect.arrayContaining(['--model', 'opus']));
  });

  it('omits the workspace root from add-dirs when there is none', async () => {
    await createSetupOps({ ...deps, workspaceRoot: () => undefined }).create();
    const args = created[0]!.opts.shellArgs;
    expect(args).not.toContain('/ws');
    expect(args).toEqual(expect.arrayContaining(['--add-dir', '/src/web']));
  });

  it('launches a core that cannot block edits once acknowledged', async () => {
    const ops = createSetupOps({
      ...deps,
      defaultAgent: () => ({ provider: 'antigravity', model: null }),
      confirmUnsafeCore: async () => true,
    });
    expect(await ops.create()).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('logs the launch line with the instruction channel, and the ack decision', async () => {
    const debugs: string[] = [];
    await createSetupOps({ ...deps, debug: (m) => void debugs.push(m) }).create();
    const launch = debugs.find((m) => m.startsWith('[setup] launch abc123: claude'));
    expect(launch).toBeDefined();
    expect(launch).toContain('native-file');
    expect(launch).toContain('instructions');

    const ackDebugs: string[] = [];
    await createSetupOps({
      ...deps,
      defaultAgent: () => ({ provider: 'antigravity', model: null }),
      confirmUnsafeCore: async () => false,
      debug: (m) => void ackDebugs.push(m),
    }).create();
    expect(ackDebugs).toContain('[setup] launch: antigravity cannot block edits — declined by the user');
  });

  it('logs the terminal-close step', async () => {
    const debugs: string[] = [];
    const ops = createSetupOps({ ...deps, debug: (m) => void debugs.push(m) });
    await ops.create();
    created[0]!.close?.(0);
    expect(debugs).toContain('[setup] terminal for abc123 closed');
  });

  it('writes the session title into the instructions and logs the exact metrics', async () => {
    const debugs: string[] = [];
    await createSetupOps({ ...deps, debug: (m) => void debugs.push(m) }).create();
    const path = created[0]!.opts.env!.KARST_INSTRUCTIONS!;
    const body = readFileSync(path, 'utf8').replace(/\n$/, '');
    expect(body).toContain('Workspace setup');
    const line = debugs.find((m) => m.startsWith('[setup] launch abc123:'));
    expect(line).toContain(`${body.length}c`);
    expect(line).toContain(hashInstructions(body));
    expect(line).toContain('native-file');
  });

  it('declines an unsafe core when nobody can ask', async () => {
    const ops = createSetupOps({
      ...deps,
      defaultAgent: () => ({ provider: 'antigravity', model: null }),
      confirmUnsafeCore: undefined,
    });
    expect(await ops.create()).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('does not forget a live terminal when a stale one for the same id closes', async () => {
    const ops = createSetupOps(deps);
    await ops.create();
    const first = created[0]!;
    await ops.create();
    expect(created).toHaveLength(2);
    first.close?.(0);
    expect(ops.isLive('abc123')).toBe(true);
  });

  it('logs an acknowledged unsafe core', async () => {
    const debugs: string[] = [];
    await createSetupOps({
      ...deps,
      defaultAgent: () => ({ provider: 'antigravity', model: null }),
      confirmUnsafeCore: async () => true,
      debug: (m) => void debugs.push(m),
    }).create();
    expect(debugs).toContain('[setup] launch: antigravity cannot block edits — acknowledged by the user');
  });
});
