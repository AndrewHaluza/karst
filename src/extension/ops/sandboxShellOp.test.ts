import { describe, expect, it, vi } from 'vitest';
import type { Notify } from './notify.js';
import { createShellAvailabilityCache, openSandboxShellOp, sandboxShellAvailability, SHELL_CHECKING } from './sandboxShellOp.js';
import { fakeDockerProcess } from '../../agent/docker/fakeDockerProcess.js';

const notify = (): Notify & { error: ReturnType<typeof vi.fn> } => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Notify & { error: ReturnType<typeof vi.fn> };
const target = (core: string | null) => ({ ticketId: 7, ticketLabel: 'T7', core, worktree: { path: '/wt/t7', branch: 'feat/x' } });

describe('openSandboxShellOp', () => {
  it('opens a terminal named after the ticket key and running the runner argv', async () => {
    const n = notify();
    const openTerminal = vi.fn();
    const dockerProc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } });
    await expect(openSandboxShellOp({ notify: n, projectRoot: '/p', dockerProc, openTerminal }, target('opencode'))).resolves.toBe(true);
    expect(openTerminal).toHaveBeenCalledTimes(1);
    const spec = openTerminal.mock.calls[0]![0];
    expect(spec.name).toBe('Karst sandbox · T7');
    expect(spec.cmd).toBe('docker');
    expect(spec.args.slice(-2)).toEqual(['sh', '-l']);
    expect(spec.cwd).toBe('/wt/t7');
    expect(n.error).not.toHaveBeenCalled();
  });

  it('shows the runner reason as an error and opens nothing when the sandbox is stopped', async () => {
    const n = notify();
    const openTerminal = vi.fn();
    const dockerProc = fakeDockerProcess({ 'docker container inspect': { stdout: 'false' } });
    await expect(openSandboxShellOp({ notify: n, projectRoot: '/p', dockerProc, openTerminal }, target('opencode'))).resolves.toBe(false);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(n.error).toHaveBeenCalledWith(expect.stringContaining('Sandbox is stopped'));
  });

  it('refuses a host ticket (no core) with "No sandbox yet"', async () => {
    const n = notify();
    await expect(openSandboxShellOp({ notify: n, projectRoot: '/p', openTerminal: vi.fn() }, target(null))).resolves.toBe(false);
    expect(n.error).toHaveBeenCalledWith(expect.stringContaining('No sandbox yet'));
  });

  it('reports availability without opening a terminal', async () => {
    const dockerProc = fakeDockerProcess({ 'docker container inspect': { stdout: 'false' } });
    await expect(sandboxShellAvailability({ notify: notify(), projectRoot: '/p', dockerProc }, target('opencode'))).resolves.toEqual({ available: false, why: 'Sandbox is stopped' });
    const running = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } });
    await expect(sandboxShellAvailability({ notify: notify(), projectRoot: '/p', dockerProc: running }, target('opencode'))).resolves.toEqual({ available: true, why: null });
  });
});

describe('createShellAvailabilityCache', () => {
  it('answers "checking" first, then the probe value, and reports the change once', async () => {
    const onChange = vi.fn();
    const probe = vi.fn().mockResolvedValue({ available: true, why: null });
    const cache = createShellAvailabilityCache({ probe, onChange, now: () => 0 });
    expect(cache.read(1)).toEqual(SHELL_CHECKING);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(1));
    expect(cache.read(1)).toEqual({ available: true, why: null });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the ttl and keeps one probe in flight', async () => {
    let t = 0;
    const probe = vi.fn().mockResolvedValue({ available: false, why: 'Sandbox is stopped' });
    const onChange = vi.fn();
    const cache = createShellAvailabilityCache({ probe, onChange, now: () => t, ttlMs: 100 });
    cache.read(1); cache.read(1);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    t = 200;
    cache.read(1);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenCalledTimes(1); // same value: no re-push
  });

  it('invalidate forces a probe at once and keeps the old value meanwhile', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ available: true, why: null }).mockResolvedValueOnce({ available: false, why: 'Sandbox is stopped' });
    const onChange = vi.fn();
    const cache = createShellAvailabilityCache({ probe, onChange, now: () => 0 });
    cache.read(1);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    cache.invalidate(1);
    expect(cache.read(1)).toEqual({ available: true, why: null });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(cache.read(1)).toEqual({ available: false, why: 'Sandbox is stopped' });
  });

  it('keeps the old value when a probe throws', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ available: true, why: null }).mockRejectedValueOnce(new Error('x'));
    const onChange = vi.fn();
    const cache = createShellAvailabilityCache({ probe, onChange, now: () => 0 });
    cache.read(1);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    cache.invalidate(1);
    cache.read(1);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(cache.read(1)).toEqual({ available: true, why: null });
  });
});
