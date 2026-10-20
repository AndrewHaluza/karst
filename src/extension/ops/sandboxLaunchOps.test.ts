import { describe, expect, it, vi } from 'vitest';
import { renderGateOnlyInstruction } from '../../agent/workflowCommand.js';
import { guardLaunchResume, HOST_FALLBACK_HOST, HOST_FALLBACK_RETRY, launchMarkerInstruction, launchWithoutSilentHostFallback, hostFallbackPrompts, wantsSandboxBackend, sandboxScrubber } from './sandboxLaunchOps.js';
import type { LaunchBackend } from './sandboxSyncOps.js';

const backend = (over: Partial<LaunchBackend> = {}): LaunchBackend => ({ options: {}, sandboxed: false, ...over });
const stagePrefix = (stage: string) => `node "$KARST_CLI" stage ${stage} pass --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket`;
const base = { core: 'opencode2', stagePrefix, ticketKey: 'K-7', hasMcp: false };

describe('launchMarkerInstruction: host vs docker vs sbx, impl and fix', () => {
  it.each(['impl', 'fix'] as const)('host %s keeps the host stage command (and its approval tail)', (stage) => {
    const text = launchMarkerInstruction({ ...base, backend: backend(), stage });
    expect(text).toContain(`stage ${stage} pass --db "$KARST_DB"`);
    expect(text).toContain('outside the workspace sandbox');
  });

  it.each([
    ['docker', '/karst-bridge/7', 'opencode2'],
    ['sbx', '/g/events/7', 'claude'],
  ] as const)('%s: emit-marker on the container-visible bridge path, for impl and fix', (_runner, runDir, core) => {
    for (const stage of ['impl', 'fix'] as const) {
      const text = launchMarkerInstruction({ ...base, core, backend: backend({ sandboxed: true, runDir }), stage });
      expect(text).toContain(`\`node ${runDir}/${core}/emit-marker.cjs ${runDir}/events.ndjson ${stage}\``);
      // Conformance: nothing of the host contract survives into a sandboxed instruction.
      expect(text).not.toMatch(/KARST_CLI|KARST_DB|KARST_MANIFEST|--db|--manifest|stage (impl|fix) pass|MCP tool `|outside the workspace sandbox/);
    }
  });

  it('review/uat/ship (no marker stage) get the gate-only text on every runner', () => {
    for (const b of [backend(), backend({ sandboxed: true, runDir: '/karst-bridge/7' })]) {
      const text = launchMarkerInstruction({ ...base, backend: b, stage: null });
      expect(text).toBe(renderGateOnlyInstruction());
      expect(text).not.toContain('emit-marker');
    }
  });

  it('a sandbox with no bridge attached promises no marker', () => {
    expect(launchMarkerInstruction({ ...base, backend: backend({ sandboxed: true }), stage: 'impl' })).toBe(renderGateOnlyInstruction());
  });
});

describe('sandboxScrubber', () => {
  it('is the identity for a host launch', () => {
    const log = vi.fn();
    expect(sandboxScrubber(false, log)('run `node "$KARST_CLI" guide`')).toBe('run `node "$KARST_CLI" guide`');
    expect(log).not.toHaveBeenCalled();
  });
  it('scrubs and logs for a sandboxed launch; undefined stays undefined', () => {
    const log = vi.fn();
    const scrub = sandboxScrubber(true, log);
    expect(scrub('run `node "$KARST_CLI" guide --db "$KARST_DB"`')).toBe('run (not available in the sandbox)');
    expect(scrub(undefined)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('scrubbed 1 host-only command(s) from the sandboxed seed');
    scrub('nothing to scrub here');
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('guardLaunchResume', () => {
  const input = (over: Partial<Parameters<typeof guardLaunchResume>[0]> = {}) => ({
    ticketId: 7, ticketLabel: 'K-7', resumeId: 'ses_1', sandboxed: false, hasSandbox: async () => true, warn: vi.fn(), ...over,
  });
  it('a host launch of a ticket with a sandbox starts fresh and says so', async () => {
    const i = input();
    await expect(guardLaunchResume(i)).resolves.toBeUndefined();
    expect(i.warn).toHaveBeenCalledWith(expect.stringContaining('fresh host session'));
  });
  it.each([
    ['a sandbox launch', { sandboxed: true }],
    ['a ticket with no sandbox', { hasSandbox: async () => false }],
  ])('keeps the resume id for %s', async (_n, over) => {
    await expect(guardLaunchResume(input(over))).resolves.toBe('ses_1');
  });
  it('no resume id: nothing to check', async () => {
    const hasSandbox = vi.fn(async () => true);
    await expect(guardLaunchResume(input({ resumeId: undefined, hasSandbox }))).resolves.toBeUndefined();
    expect(hasSandbox).not.toHaveBeenCalled();
  });
  it('the guard sees the runner kind: a sandbox launch is not a host resume', async () => {
    const hasSandbox = vi.fn(async () => true);
    await expect(guardLaunchResume(input({ sandboxed: true, hasSandbox }))).resolves.toBe('ses_1');
    expect(hasSandbox).toHaveBeenCalledTimes(1);
  });
  it('a listing failure propagates (never swallowed into a wrong resume)', async () => {
    await expect(guardLaunchResume(input({ hasSandbox: async () => { throw new Error('boom'); } }))).rejects.toThrow('boom');
  });
});

describe('launchWithoutSilentHostFallback (F14)', () => {
  const host = { sandboxed: false };
  const box = { sandboxed: true };
  const base = (over: Record<string, unknown>) => ({
    ticketLabel: 'K-1', wantsSandbox: true, hasSandbox: async () => true,
    choose: vi.fn(async () => undefined as string | undefined), confirmHost: vi.fn(async () => true), removeSandbox: vi.fn(async () => true),
    launch: vi.fn(async () => host), ...over,
  });
  it('launches straight through when sandboxed or no sandbox exists', async () => {
    const a = base({ launch: async () => box });
    expect(await launchWithoutSilentHostFallback(a)).toMatchObject({ kind: 'launched', freshSession: false });
    const b = base({ hasSandbox: async () => false });
    expect(await launchWithoutSilentHostFallback(b)).toMatchObject({ kind: 'launched' });
    expect(b.choose).not.toHaveBeenCalled();
  });
  it('cancel (or dismissing) does nothing', async () => {
    const i = base({});
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'cancelled' });
    expect(i.removeSandbox).not.toHaveBeenCalled();
    expect(i.launch).toHaveBeenCalledTimes(1);
  });
  it('retry re-launches', async () => {
    const launch = vi.fn().mockResolvedValueOnce(host).mockResolvedValueOnce(box);
    const i = base({ launch, choose: vi.fn(async () => HOST_FALLBACK_RETRY) });
    expect(await launchWithoutSilentHostFallback(i)).toMatchObject({ kind: 'launched', backend: box });
  });
  it('host option without explicit confirmation removes nothing', async () => {
    const i = base({ choose: vi.fn(async () => HOST_FALLBACK_HOST), confirmHost: vi.fn(async () => false) });
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'cancelled' });
    expect(i.removeSandbox).not.toHaveBeenCalled();
  });
  it('confirmed host option removes the sandbox and launches fresh; a kept sandbox cancels', async () => {
    const i = base({ choose: vi.fn(async () => HOST_FALLBACK_HOST) });
    expect(await launchWithoutSilentHostFallback(i)).toMatchObject({ kind: 'launched', freshSession: true });
    expect(i.confirmHost).toHaveBeenCalledWith(expect.stringContaining('WITHOUT the sandbox boundary'));
    const kept = base({ choose: vi.fn(async () => HOST_FALLBACK_HOST), removeSandbox: vi.fn(async () => false) });
    expect(await launchWithoutSilentHostFallback(kept)).toEqual({ kind: 'cancelled' });
  });
});

describe('wantsSandboxBackend / hostFallbackPrompts', () => {
  it('is true only for a non-host effective backend', () => {
    expect(wantsSandboxBackend(undefined, 'claude', undefined)).toBe(false);
    expect(wantsSandboxBackend({ opencode: 'docker' }, 'opencode', undefined)).toBe(true);
    expect(wantsSandboxBackend({ opencode: 'docker' }, 'opencode', 'host')).toBe(false);
  });
  it('choose passes the options through; confirm needs the explicit button', async () => {
    const show = vi.fn(async () => 'Run on host' as string | undefined);
    const p = hostFallbackPrompts({ showWarningMessage: show });
    await p.choose('m', ['a', 'b']);
    expect(show).toHaveBeenCalledWith('m', 'a', 'b');
    expect(await p.confirmHost('x')).toBe(true);
    expect(show).toHaveBeenLastCalledWith('x', { modal: true }, 'Run on host');
    show.mockResolvedValueOnce(undefined);
    expect(await p.confirmHost('x')).toBe(false);
  });
});
