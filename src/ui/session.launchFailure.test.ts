import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../agent/adapter.js';
import { captureFilesFor } from '../agent/launchCapture.js';
import { HOST_SESSION_RUNNER, type SessionRunner } from '../agent/sessionRunner.js';
import { bridgePaths } from '../agent/bridge/bridgeDir.js';
import { DefaultedSessionManager } from './testing/launchDefaults.js';
import type { CreateTerminalOpts, SessionTerminal, TerminalHost } from './session.js';

const adapter: AgentAdapter = {
  buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
  runHeadless: () => Promise.reject(new Error('not used')),
  requiredBinary: 'claude',
  capabilities: { lifecycleEvents: true, resume: true, submitDelayMs: 100 },
} as unknown as AgentAdapter;

const sandboxRunner = (kind: 'sbx' | 'docker'): SessionRunner => ({
  kind,
  enforcesSandbox: true,
  bridgeRunDir: (p) => p.dir,
  placeInteractive: () => ({ cwd: '/clone', shellPath: kind, shellArgs: ['run'], env: {} }),
  runHeadless: () => Promise.reject(new Error('not used')),
});

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-launchfail-'));
  home = mkdtempSync(join(tmpdir(), 'karst-launchfail-home-'));
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function harness(): { host: TerminalHost; created: CreateTerminalOpts[]; close: (code?: number) => void } {
  const created: CreateTerminalOpts[] = [];
  let onClose: (code?: number) => void = () => undefined;
  const terminal: SessionTerminal = {
    show: () => undefined,
    sendText: () => undefined,
    dispose: () => undefined,
    onDidClose: (h) => (onClose = h),
  };
  const host = { createTerminal: (o: CreateTerminalOpts) => (created.push(o), terminal), restoredSessions: () => [] } as unknown as TerminalHost;
  return { host, created, close: (code) => onClose(code) };
}

const channelFor = () => ({ endpointUrl: 'http://127.0.0.1:1/h', configDir: '/r', launchId: '123e4567-e89b-42d3-a456-426614174000' });

async function open(runner: SessionRunner, onSandboxLaunchFailed: (i: unknown) => void, h = harness()) {
  const mgr = new DefaultedSessionManager(h.host, channelFor);
  await mgr.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    resolveRunner: () => Promise.resolve({ runner, line: 'x' }),
    launchCaptureDir: dir,
    onSandboxLaunchFailed,
  });
  return h;
}

describe('sandbox launch failure capture (arch:AC-32)', () => {
  it('wraps a sandbox launch so its stderr is kept', async () => {
    const h = await open(sandboxRunner('sbx'), () => undefined);
    expect(h.created[0]!.shellPath).toBe('/bin/bash');
    expect(h.created[0]!.shellArgs).toContain(captureFilesFor(dir, 7).stderr);
  });

  it('threads bridge eventsFile to the bash capture wrapper when bridge is present', async () => {
    const h = harness();
    const mgr = new DefaultedSessionManager(h.host, channelFor);
    const paths = bridgePaths(dir, 7);
    await mgr.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      resolveRunner: () => Promise.resolve({ runner: sandboxRunner('sbx'), line: 'x' }),
      launchCaptureDir: dir,
      bridge: { paths },
    });
    expect(h.created[0]!.shellArgs).toContain(paths.eventsFile);
  });

  it('reports runner, exit code and stderr tail when the launch failed fast', async () => {
    const seen: unknown[] = [];
    const h = await open(sandboxRunner('sbx'), (i) => seen.push(i));
    const files = captureFilesFor(dir, 7);
    writeFileSync(files.stderr, '--clone is not supported when run from a Git worktree');
    writeFileSync(files.fast, '1\n');
    h.close(1);
    expect(seen).toEqual([{ runner: 'sbx', exitCode: 1, tail: '--clone is not supported when run from a Git worktree' }]);
    expect(existsSync(files.stderr)).toBe(false);
  });

  it('records nothing for a normal long-running session', async () => {
    const seen: unknown[] = [];
    const h = await open(sandboxRunner('docker'), (i) => seen.push(i));
    writeFileSync(captureFilesFor(dir, 7).stderr, 'some warning');
    h.close(0);
    expect(seen).toEqual([]);
  });

  it('drops a stale marker at launch so a healthy session reports nothing', async () => {
    const files = captureFilesFor(dir, 7);
    writeFileSync(files.fast, '1\n');
    const seen: unknown[] = [];
    const h = await open(sandboxRunner('sbx'), (i) => seen.push(i));
    expect(existsSync(files.fast)).toBe(false);
    h.close(0);
    expect(seen).toEqual([]);
  });

  it('a throwing failure handler cannot break the close handler', async () => {
    const h = await open(sandboxRunner('sbx'), () => {
      throw new Error('boom');
    });
    writeFileSync(captureFilesFor(dir, 7).fast, '1\n');
    expect(() => h.close(1)).not.toThrow();
  });

  it('leaves a host launch untouched', async () => {
    const h = await open(HOST_SESSION_RUNNER, () => undefined);
    expect(h.created[0]!.shellPath).not.toBe('/bin/bash');
  });
});
