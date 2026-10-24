import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LAUNCH_FAILURE_FILE, sandboxLaunchFailureOptions, type SandboxLaunchFailureInput } from './sandboxLaunchFailureOps.js';
import { DOCKER_MEMORY_HELP_TEXT } from './sandboxSetupOp.js';

let root: string | undefined;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function setup(removeSandbox?: () => Promise<unknown>, extra: Partial<SandboxLaunchFailureInput> = {}) {
  root = mkdtempSync(join(tmpdir(), 'karst-lf-'));
  const captureDir = join(root, 'artifacts', 'T704');
  const warns: string[] = [];
  const notified: string[] = [];
  const marked: number[] = [];
  const opts = sandboxLaunchFailureOptions({
    ticketId: 4, ticketLabel: 'T704', core: 'claude', captureDir,
    warn: (l) => warns.push(l),
    notify: { info: () => undefined, warn: (m) => notified.push(m), error: () => Promise.resolve() },
    markNotStarted: (id) => marked.push(id),
    ...(removeSandbox ? { removeSandbox } : {}),
    ...extra,
  });
  return { captureDir, warns, notified, marked, opts };
}

describe('sandboxLaunchFailureOptions', () => {
  it('creates the per-ticket capture dir up front', () => {
    const { captureDir, opts } = setup();
    expect(opts.launchCaptureDir).toBe(captureDir);
    expect(existsSync(captureDir)).toBe(true);
  });

  it('logs, marks the ticket, stores the reason and hints at the host fallback', () => {
    let failureFileExistedWhenMarked = false;
    let capturePath = '';
    const marked: number[] = [];
    const { captureDir, warns, notified, opts } = setup(undefined, {
      markNotStarted: (id) => {
        failureFileExistedWhenMarked = existsSync(join(capturePath, LAUNCH_FAILURE_FILE));
        marked.push(id);
      },
    });
    capturePath = captureDir;
    opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: '--clone is not supported\n' });
    const line = '[session] ticket T704 sandbox launch failed (runner: sbx, exit 1): --clone is not supported';
    expect(warns).toEqual([line]);
    expect(marked).toEqual([4]);
    expect(failureFileExistedWhenMarked).toBe(true);
    expect(readFileSync(join(captureDir, LAUNCH_FAILURE_FILE), 'utf8')).toBe(`${line}\n`);
    expect(notified[0]).toContain('agentBackends.claude=host');
    expect(notified[0]).toContain('Retry');
  });

  it('ignores a failure when Karst itself ended the session', () => {
    const { warns, notified, marked, opts } = setup(undefined, { hostEnded: (id) => id === 4 });
    opts.onSandboxLaunchFailed({ runner: 'docker', exitCode: 143, tail: '' });
    expect([warns, notified, marked]).toEqual([[], [], []]);
  });

  it('appends the Docker memory help to an exit-137 kill', async () => {
    const { notified, opts } = setup(undefined, { killContext: async () => 'Docker VM 4.0 GB' });
    opts.onSandboxLaunchFailed({ runner: 'docker', exitCode: 137, tail: 'Killed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(notified[0]).toContain(DOCKER_MEMORY_HELP_TEXT);
    expect(notified[0]).toContain('Docker VM 4.0 GB');
  });

  it('adds the help for 137 without a kill context, and omits it for other codes', () => {
    const a = setup();
    a.opts.onSandboxLaunchFailed({ runner: 'docker', exitCode: 137, tail: '' });
    expect(a.notified[0]).toContain(DOCKER_MEMORY_HELP_TEXT);
    const b = setup();
    b.opts.onSandboxLaunchFailed({ runner: 'docker', exitCode: 1, tail: '' });
    expect(b.notified[0]).not.toContain(DOCKER_MEMORY_HELP_TEXT);
  });

  it('omits the memory help for a non-137 code or a non-docker runner, even with a kill context', async () => {
    const ctx = { killContext: async () => 'Docker VM 4.0 GB' };
    const a = setup(undefined, ctx);
    a.opts.onSandboxLaunchFailed({ runner: 'docker', exitCode: 1, tail: '' });
    const b = setup(undefined, ctx);
    b.opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 137, tail: '' });
    await new Promise((r) => setTimeout(r, 0));
    expect(a.notified[0]).not.toContain('Docker VM');
    expect(b.notified[0]).not.toContain(DOCKER_MEMORY_HELP_TEXT);
  });

  it('removes the half-built sandbox a failed launch leaves behind', () => {
    let removed = 0;
    const { opts } = setup(async () => { removed += 1; });
    opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'failed to inject network proxy' });
    expect(removed).toBe(1);
  });

  it('a failing removal is logged, never thrown', async () => {
    const { warns, opts } = setup(async () => { throw new Error('daemon down'); });
    opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(warns.some((w) => w.includes('half-built sandbox') && w.includes('daemon down'))).toBe(true);
  });
});
