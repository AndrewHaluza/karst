import { describe, expect, it, vi } from 'vitest';
import { renderGateOnlyInstruction } from '../../agent/workflowCommand.js';
import { ACCOUNT_BLOCK_DEFAULT, ACCOUNT_BLOCK_HOST, guardLaunchResume, HOST_FALLBACK_HOST, HOST_FALLBACK_RETRY, launchMarkerInstruction, launchWithoutSilentHostFallback, hostFallbackPrompts, wantsSandboxBackend, wantsSbxBackend, sandboxScrubber } from './sandboxLaunchOps.js';
import type { LaunchBackend } from './sandboxSyncOps.js';

const backend = (over: Partial<LaunchBackend> = {}): LaunchBackend => ({ options: {}, sandboxed: false, placement: { backend: 'host', core: null, sandboxName: null, reason: null }, ...over });
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
  describe('failClosed (an Autopilot round, arch:AC-31)', () => {
    it('refuses a host launch without a choice, a removal or a second launch', async () => {
      const i = base({ failClosed: true });
      const r = await launchWithoutSilentHostFallback(i);
      expect(r).toEqual({ kind: 'refused', reason: 'the sandbox backend is unavailable and auto-fix never runs on the host' });
      expect(i.choose).not.toHaveBeenCalled();
      expect(i.removeSandbox).not.toHaveBeenCalled();
      expect(i.launch).toHaveBeenCalledTimes(1);
    });
    it('checks failClosed BEFORE hasSandbox: a listing failure does not launch on the host', async () => {
      const hasSandbox = vi.fn(async () => { throw new Error('listing failed'); });
      const r = await launchWithoutSilentHostFallback(base({ failClosed: true, hasSandbox }));
      expect(r.kind).toBe('refused');
      expect(hasSandbox).not.toHaveBeenCalled();
    });
    it('refuses even when the ticket has no sandbox yet and the backend wants one', async () => {
      const r = await launchWithoutSilentHostFallback(base({ failClosed: true, hasSandbox: async () => false }));
      expect(r.kind).toBe('refused');
    });
    it('still launches a sandboxed backend', async () => {
      expect(await launchWithoutSilentHostFallback(base({ failClosed: true, launch: async () => box }))).toMatchObject({ kind: 'launched', freshSession: false });
    });
    it('a ticket that does not want a sandbox launches on the host', async () => {
      expect(await launchWithoutSilentHostFallback(base({ failClosed: true, wantsSandbox: false }))).toMatchObject({ kind: 'launched' });
    });
  });
  it('confirmed host option removes the sandbox and launches fresh; a kept sandbox cancels', async () => {
    const i = base({ choose: vi.fn(async () => HOST_FALLBACK_HOST) });
    expect(await launchWithoutSilentHostFallback(i)).toMatchObject({ kind: 'launched', freshSession: true });
    expect(i.confirmHost).toHaveBeenCalledWith(expect.stringContaining('WITHOUT the sandbox boundary'));
    const kept = base({ choose: vi.fn(async () => HOST_FALLBACK_HOST), removeSandbox: vi.fn(async () => false) });
    expect(await launchWithoutSilentHostFallback(kept)).toEqual({ kind: 'cancelled' });
  });
});

describe('launchWithoutSilentHostFallback: account block on a sandbox backend', () => {
  const reason = "claude account 'nd' has its own login, which the sbx sandbox does not use";
  const blocked = { sandboxed: false, blocked: { kind: 'account' as const, reason } };
  const base = (over: Record<string, unknown>) => ({
    ticketLabel: 'K-1', wantsSandbox: true, hasSandbox: async () => false,
    choose: vi.fn(async () => undefined as string | undefined), confirmHost: vi.fn(async () => true), removeSandbox: vi.fn(async () => true),
    launch: vi.fn(async () => blocked), ...over,
  });
  it('asks, never launches on the host unasked, and offers no Retry (no sandbox)', async () => {
    const i = base({});
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'cancelled' });
    expect(i.choose).toHaveBeenCalledTimes(1);
    const [message, options] = i.choose.mock.calls[0] as unknown as [string, string[]];
    expect(message).toContain(reason);
    expect(options).toEqual([ACCOUNT_BLOCK_DEFAULT, ACCOUNT_BLOCK_HOST]);
    expect(i.removeSandbox).not.toHaveBeenCalled();
  });
  it('offers no Retry with an existing sandbox, and removes nothing unless the host is chosen', async () => {
    const i = base({ hasSandbox: async () => true });
    await launchWithoutSilentHostFallback(i);
    expect((i.choose.mock.calls[0] as unknown as [string, string[]])[1]).not.toContain(HOST_FALLBACK_RETRY);
    expect(i.removeSandbox).not.toHaveBeenCalled();
  });
  it('Start fresh under default: restarts, no second launch here, no host run', async () => {
    const i = base({ choose: vi.fn(async () => ACCOUNT_BLOCK_DEFAULT) });
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'restart-default' });
    expect(i.launch).toHaveBeenCalledTimes(1);
    expect(i.confirmHost).not.toHaveBeenCalled();
  });
  it('Run on host: launches the host backend after an explicit confirm', async () => {
    const i = base({ choose: vi.fn(async () => ACCOUNT_BLOCK_HOST) });
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'launched', backend: blocked, freshSession: false });
    expect(i.confirmHost).toHaveBeenCalledTimes(1);
    expect(i.removeSandbox).not.toHaveBeenCalled();
  });
  it('Run on host with an existing sandbox syncs and removes it, then starts a fresh host session', async () => {
    const i = base({ hasSandbox: async () => true, choose: vi.fn(async () => ACCOUNT_BLOCK_HOST) });
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'launched', backend: blocked, freshSession: true });
    expect(i.confirmHost.mock.calls[0]![0]).toMatch(/synced to the host branch and the sandbox removed/);
    expect(i.removeSandbox).toHaveBeenCalledTimes(1);
    expect(i.launch).toHaveBeenCalledTimes(2);
  });
  it('Run on host with an existing sandbox that is kept cancels', async () => {
    const i = base({ hasSandbox: async () => true, choose: vi.fn(async () => ACCOUNT_BLOCK_HOST), removeSandbox: vi.fn(async () => false) });
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'cancelled' });
  });
  it('Run on host without the confirm cancels', async () => {
    const i = base({ choose: vi.fn(async () => ACCOUNT_BLOCK_HOST), confirmHost: vi.fn(async () => false) });
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'cancelled' });
  });
  it.each([['failClosed'], ['refuseOnBlock']])('%s: no modal, refused with the account reason', async (flag) => {
    const i = base({ [flag]: true, hasSandbox: async () => true });
    expect(await launchWithoutSilentHostFallback(i)).toEqual({ kind: 'refused', reason: `${reason}; the launch never runs on the host unasked` });
    expect(i.choose).not.toHaveBeenCalled();
    expect(i.launch).toHaveBeenCalledTimes(1);
  });
  it('a host-backend ticket (wantsSandbox false) is not asked', async () => {
    const i = base({ wantsSandbox: false });
    expect(await launchWithoutSilentHostFallback(i)).toMatchObject({ kind: 'launched' });
    expect(i.choose).not.toHaveBeenCalled();
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

describe('wantsSbxBackend', () => {
  it('is true only for the sbx backend, not docker or host', () => {
    expect(wantsSbxBackend({ claude: 'sbx' } as never, 'claude', null)).toBe(true);
    expect(wantsSbxBackend({ claude: 'docker' } as never, 'claude', null)).toBe(false);
    expect(wantsSbxBackend({ claude: 'sbx' } as never, 'claude', 'host')).toBe(false);
  });
});
