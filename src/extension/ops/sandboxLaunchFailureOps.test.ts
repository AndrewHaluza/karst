import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  describe('an Autopilot round that dies after launch (arch:AC-31)', () => {
    it('reports the death to the round hook and offers no host action', async () => {
      const died: Array<[number, string]> = [];
      const errorActions = vi.fn(async () => undefined);
      const runOnHost = vi.fn();
      const { opts } = setup(undefined, {
        failClosed: true, runOnHost, onRoundDied: (id, detail) => died.push([id, detail]),
        notify: { info: () => undefined, warn: () => undefined, error: () => Promise.resolve(), errorActions },
      });
      opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'boom\n' });
      expect(died).toEqual([[4, 'sbx sandbox launch failed (exit 1): boom']]);
      expect(errorActions).not.toHaveBeenCalled();
    });
    it('reports a stopped sandbox too, but not an exit karst itself caused', () => {
      const died: string[] = [];
      const hostEnded = vi.fn(() => false);
      const { opts } = setup(undefined, { onRoundDied: (_i, d) => died.push(d), hostEnded });
      opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'sandbox stopped\n' });
      expect(died).toHaveLength(1);
      hostEnded.mockReturnValue(true);
      opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'boom\n' });
      expect(died).toHaveLength(1);
    });
    it('a hook that throws does not hide the failure notice', () => {
      const { opts, warns } = setup(undefined, { onRoundDied: () => { throw new Error('hook'); } });
      opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'boom\n' });
      expect(warns.some((w) => w.includes('launch failed'))).toBe(true);
      expect(warns.some((w) => w.includes('hook'))).toBe(true);
    });
  });

  describe('stale resume id (T896)', () => {
    const tail = 'No conversation found with session ID: f5dadfcf-d1bb-4fc5-beff-0a81b3fb9c8e\n';

    it('drops the id, logs it and relaunches once, without the failure notice or sandbox removal', () => {
      const dropped: number[] = [];
      const retried: number[] = [];
      let removed = 0;
      const { warns, notified, marked, opts } = setup(async () => { removed += 1; }, {
        dropStaleResume: (id) => { dropped.push(id); },
        retrySandbox: (id) => { retried.push(id); },
      });
      opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail });
      expect(dropped).toEqual([4]);
      expect(retried).toEqual([4]);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('dropping the stored session id');
      expect([notified, marked, removed]).toEqual([[], [], 0]);
    });

    it('reports a normal failure when no drop handler is wired', () => {
      const { notified, marked, opts } = setup();
      opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail });
      expect(marked).toEqual([4]);
      expect(notified).toHaveLength(1);
    });

    it('does not drop the id for an unrelated failure', () => {
      const dropped: number[] = [];
      const { marked, opts } = setup(undefined, { dropStaleResume: (id) => { dropped.push(id); } });
      opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'boom' });
      expect([dropped, marked]).toEqual([[], [4]]);
    });
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

  describe('recovery actions', () => {
    function withActions(choice: string | undefined, extra: Partial<SandboxLaunchFailureInput> = {}) {
      const asked: { message: string; actions: readonly string[] }[] = [];
      const calls: string[] = [];
      const r = setup(undefined, {
        notify: {
          info: () => undefined, warn: () => undefined, error: () => Promise.resolve(),
          errorActions: async (message, actions) => { asked.push({ message, actions }); return choice; },
        },
        runOnHost: (id) => { calls.push(`host:${id}`); },
        retrySandbox: (id) => { calls.push(`retry:${id}`); },
        ...extra,
      });
      r.opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: '' });
      return { ...r, asked, calls };
    }
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it('offers Run on Host and Retry Sandbox', async () => {
      const { asked } = withActions(undefined);
      await settle();
      expect(asked).toHaveLength(1);
      expect(asked[0]!.actions).toEqual(['Run on Host', 'Retry Sandbox']);
      expect(asked[0]!.message).toContain('sandbox launch failed');
    });

    it('Run on Host runs the host callback only', async () => {
      const { calls } = withActions('Run on Host');
      await settle();
      expect(calls).toEqual(['host:4']);
    });

    it('Retry Sandbox runs the retry callback only', async () => {
      const { calls } = withActions('Retry Sandbox');
      await settle();
      expect(calls).toEqual(['retry:4']);
    });

    it('dismissal runs nothing', async () => {
      const { calls } = withActions(undefined);
      await settle();
      expect(calls).toEqual([]);
    });

    it('logs a failing callback instead of throwing', async () => {
      const { warns } = withActions('Run on Host', { runOnHost: () => Promise.reject(new Error('boom')) });
      await settle();
      expect(warns.some((w) => w.includes('boom'))).toBe(true);
    });

    it('keeps the plain warning without runOnHost', () => {
      const { notified } = setup();
      expect(notified).toEqual([]);
    });

    it('offers the actions on the exit-137 memory path too', async () => {
      const { asked } = withActions(undefined, {});
      expect(asked).toHaveLength(1);
      const b = setup(undefined, {
        notify: { info: () => undefined, warn: () => undefined, error: () => Promise.resolve(), errorActions: async (m, a) => { asked.push({ message: m, actions: a }); return undefined; } },
        runOnHost: () => undefined,
      });
      b.opts.onSandboxLaunchFailed({ runner: 'docker', exitCode: 137, tail: '' });
      await settle();
      expect(asked[1]!.message).toContain(DOCKER_MEMORY_HELP_TEXT);
    });
  });

  it('treats a "was stopped" exit as a sandbox stop: interrupts the run, parks, names the stop, no host hint', () => {
    const interrupted: Array<[number, string]> = [];
    const { warns, notified, marked, opts, captureDir } = setup(undefined, {
      interruptRun: (id, d) => interrupted.push([id, d]),
    });
    opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'error: sandbox "karst-x-claude" was stopped\n' });
    expect(interrupted).toEqual([[4, 'sandbox stopped']]);
    expect(marked).toEqual([4]);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('sandbox was stopped');
    expect(notified[0]).not.toContain('agentBackends');
    expect(notified[0]).not.toContain('launch failed');
    expect(warns.join()).not.toContain('launch failed');
    expect(existsSync(join(captureDir, LAUNCH_FAILURE_FILE))).toBe(false);
  });

  it('offers Relaunch on a sandbox stop and runs the open-session path', async () => {
    const relaunched: number[] = [];
    const { opts } = setup(undefined, {
      notify: { info: () => undefined, warn: () => undefined, error: () => Promise.resolve(), errorActions: (_m: string, a: string[]) => { expect(a).toEqual(['Relaunch']); return Promise.resolve('Relaunch'); } },
      retrySandbox: (id) => { relaunched.push(id); },
    });
    opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: 'error: sandbox "n" was stopped' });
    await new Promise((r) => setTimeout(r, 0));
    expect(relaunched).toEqual([4]);
  });
});

describe('sbx exit 137 is reported as an out-of-memory kill', () => {
  it('shows the OOM text, not a launch failure, and keeps the sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oom-'));
    const warn = vi.fn();
    const removeSandbox = vi.fn(async () => undefined);
    const markNotStarted = vi.fn();
    const interruptRun = vi.fn();
    const opts = sandboxLaunchFailureOptions({
      ticketId: 7, ticketLabel: 'T7', core: 'claude', captureDir: dir, warn: () => undefined, notify: { info: vi.fn(), warn, error: async () => undefined },
      markNotStarted, removeSandbox, interruptRun, oomReport: async () => 'Sandbox s ran out of memory (limit 6 GB): killed node.',
    });
    opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 137, tail: '' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0]![0]).toContain('ran out of memory (limit 6 GB): killed node');
    expect(warn.mock.calls[0]![0]).not.toContain('launch failed');
    expect(removeSandbox).not.toHaveBeenCalled();
    expect(markNotStarted).toHaveBeenCalledWith(7);
    expect(interruptRun).toHaveBeenCalledWith(7, expect.stringContaining('ran out of memory'));
  });

  it('still resets the state and shows the notice when closing the run throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oom-'));
    const warn = vi.fn();
    const markNotStarted = vi.fn();
    const opts = sandboxLaunchFailureOptions({
      ticketId: 7, ticketLabel: 'T7', core: 'claude', captureDir: dir, warn: () => undefined, notify: { info: vi.fn(), warn, error: async () => undefined },
      markNotStarted, interruptRun: () => { throw new Error('db locked'); }, oomReport: async () => 'Sandbox s ran out of memory (limit 6 GB): killed node.',
    });
    opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 137, tail: '' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(markNotStarted).toHaveBeenCalledWith(7);
  });
});
