import { describe, expect, it, vi } from 'vitest';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { APPROVAL_KEY_ENV, type OauthIssue, type SbxOauthGrants } from './sbxOauthGuest.js';
import { createSbxSessionRunner } from './sbxRunner.js';

const NAME = 'karst-ab12cd34-7-claude';
const KEY = 'S3CRET-KEY-VALUE-0123456789-abcdefghijklmnop';
const spec = { ticketId: 7, hostWorktreePath: '/wt', command: 'claude', args: [], env: { KARST_TICKET: '7' } };
const link = { bridgeDir: '/bridge/7', hostWorktreePath: '/wt' };

function grants(over: Partial<SbxOauthGrants> = {}): SbxOauthGrants & { issue: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  return {
    issue: vi.fn(async (): Promise<OauthIssue> => ({ ok: true, key: KEY, port: 8787 })),
    release: vi.fn(async () => ({ port: 8787 })),
    ...over,
  } as never;
}
const make = (g: SbxOauthGrants, existing: string[], account: string | null = 'work', proc = fakeSbxProcess()) =>
  ({ proc, runner: createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing, oauth: { grants: g, ...(account !== null ? { account } : {}) } }) });
const sbxCalls = (proc: ReturnType<typeof fakeSbxProcess>) => [...proc.probes, ...proc.calls].filter((c) => c.command === 'sbx');

describe('sbx launch through the proxy', () => {
  it('passes the base url as a pair and the key by name, with the value only in the client env', async () => {
    const { runner } = make(grants(), [NAME]);
    expect((await runner.prepareLaunch!()).ok).toBe(true);
    const placed = runner.placeInteractive(spec);
    expect(placed.shellArgs).toContain('ANTHROPIC_BASE_URL=http://host.docker.internal:8787');
    expect(placed.shellArgs.slice(placed.shellArgs.indexOf('ANTHROPIC_API_KEY') - 1, placed.shellArgs.indexOf('ANTHROPIC_API_KEY') + 1)).toEqual(['--env', 'ANTHROPIC_API_KEY']);
    expect(placed.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(JSON.stringify(placed.shellArgs)).not.toContain(KEY);
  });

  it('marks a launch that holds the key in its env as transient, and a launch without a key as not', async () => {
    const a = make(grants(), [NAME]);
    await a.runner.prepareLaunch!();
    expect(a.runner.placeInteractive(spec).transient).toBe(true);
    const b = make(grants(), [NAME], null);
    await b.runner.prepareLaunch!();
    expect(b.runner.placeInteractive(spec).transient).toBeUndefined();
  });

  it('puts the same pairs on a new sandbox, after its create, and on a reattach', async () => {
    for (const existing of [[], [NAME]]) {
      const { runner } = make(grants(), existing);
      await runner.prepareLaunch!();
      if (existing.length === 0) await runner.linkTranscripts!(link);
      const args = runner.placeInteractive(spec).shellArgs;
      expect(args).toContain('ANTHROPIC_BASE_URL=http://host.docker.internal:8787');
      // A new sandbox is created by the link step, so the run then reattaches to it.
      expect(args.includes('--clone')).toBe(false);
    }
  });

  it('refuses to place a launch that was not prepared', () => {
    const { runner } = make(grants(), [NAME]);
    expect(() => runner.placeInteractive(spec)).toThrow(/not prepared/);
  });

  it('issues a new key for each launch', async () => {
    const g = grants();
    const { runner } = make(g, [NAME]);
    await runner.prepareLaunch!();
    await runner.prepareLaunch!();
    expect(g.issue).toHaveBeenCalledTimes(2);
    expect(g.issue).toHaveBeenCalledWith(NAME, 'work');
  });

  it('allows the proxy port and approves the key before an existing sandbox runs, the key only in the exec client env', async () => {
    const { runner, proc } = make(grants(), [NAME]);
    expect((await runner.prepareLaunch!()).ok).toBe(true);
    const calls = sbxCalls(proc);
    const allow = calls.findIndex((c) => c.args[0] === 'policy' && c.args[1] === 'allow');
    const approve = calls.findIndex((c) => c.args[0] === 'exec' && c.args.includes(APPROVAL_KEY_ENV));
    expect(allow).toBeGreaterThanOrEqual(0);
    expect(approve).toBeGreaterThan(allow);
    expect(calls[allow]!.args.at(-1)).toBe('localhost:8787,host.docker.internal:8787');
    expect(calls[approve]!.opts?.env).toEqual({ [APPROVAL_KEY_ENV]: KEY });
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(KEY);
  });

  it('waits for a new sandbox: policy and approval run after the create, before the transcript link', async () => {
    const { runner, proc } = make(grants(), []);
    await runner.prepareLaunch!();
    expect(sbxCalls(proc).filter((c) => c.args[0] === 'policy' || c.args[0] === 'exec')).toHaveLength(0);
    expect((await runner.linkTranscripts!(link)).ok).toBe(true);
    const order = sbxCalls(proc).map((c) => (c.args[0] === 'policy' ? 'policy' : c.args.includes(APPROVAL_KEY_ENV) ? 'approve' : c.args[0]!));
    expect(order.slice(0, 3)).toEqual(['create', 'policy', 'approve']);
    expect(order).toContain('exec');
  });

  it('fails the prepare, with the reason, when the proxy refuses a key', async () => {
    const { runner } = make(grants({ issue: async () => ({ ok: false, reason: 'no token' }) }), [NAME]);
    expect(await runner.prepareLaunch!()).toEqual({ ok: false, reason: 'no token' });
  });

  it('launches a default account when the release of a stale grant throws, and logs without the error text', async () => {
    const log: string[] = [];
    const g = grants({ release: vi.fn(async () => { throw new Error('keychain sk-ant-secret'); }) });
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [NAME], log: (m: string) => log.push(m), oauth: { grants: g } });
    expect((await runner.prepareLaunch!()).ok).toBe(true);
    expect(log.join()).toMatch(/stale grant/);
    expect(log.join()).not.toContain('secret');
  });

  it('bounds the guest stderr in the reason of a failed approval', async () => {
    const proc = fakeSbxProcess({ 'sbx exec': { code: 1, stderr: 'x'.repeat(5000) } });
    const { runner } = make(grants(), [NAME], 'work', proc);
    const out = await runner.prepareLaunch!();
    expect(out.ok === false && out.reason.length).toBeLessThan(500);
  });

  it('refuses to place a launch of a new sandbox whose guest setup failed, and a retry can place it', async () => {
    const proc = fakeSbxProcess({ 'sbx policy allow': { code: 1, stderr: 'denied' } });
    const { runner } = make(grants(), [], 'work', proc);
    await runner.prepareLaunch!();
    const linked = await runner.linkTranscripts!(link);
    expect(linked.ok).toBe(false);
    expect(() => runner.placeInteractive(spec)).toThrow(/not approved in the guest/);
  });

  it('fails the prepare when the policy rule is refused', async () => {
    const proc = fakeSbxProcess({ 'sbx policy allow': { code: 1, stderr: 'denied' } });
    const { runner } = make(grants(), [NAME], 'work', proc);
    const out = await runner.prepareLaunch!();
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/policy allow failed: denied/);
  });

  it('removes the policy rule of a replaced key on another port', async () => {
    const g = grants({ issue: async () => ({ ok: true, key: KEY, port: 9000, replacedPort: 8787 }) });
    const { runner, proc } = make(g, [NAME]);
    await runner.prepareLaunch!();
    const rm = sbxCalls(proc).find((c) => c.args[0] === 'policy' && c.args[1] === 'rm');
    expect(rm?.args).toContain('localhost:8787,host.docker.internal:8787');
  });

  it('adds no pair and no key for an account without a token, and releases a stale grant', async () => {
    const g = grants();
    const { runner } = make(g, [NAME], null);
    expect((await runner.prepareLaunch!()).ok).toBe(true);
    expect(g.issue).not.toHaveBeenCalled();
    expect(g.release).toHaveBeenCalledWith(NAME);
    const placed = runner.placeInteractive(spec);
    expect(placed.shellArgs).not.toContain('ANTHROPIC_API_KEY');
    expect(placed.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('still removes the sandbox, and logs without the error text, when the grant release throws', async () => {
    const log: string[] = [];
    const proc = fakeSbxProcess();
    const g = grants({ release: vi.fn(async () => { throw new Error('keychain locked sk-ant-secret'); }) });
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [NAME], log: (m: string) => log.push(m), oauth: { grants: g, account: 'work' } });
    await runner.dispose!({ hostWorktreePath: '', branch: 'b' });
    expect(sbxCalls(proc).some((c) => c.args[0] === 'rm' && c.args[1] === '--force')).toBe(true);
    expect(log.join()).toMatch(/grant release failed/);
    expect(log.join()).not.toContain('secret');
  });

  it('stops a guest setup that hangs past the time limit, with a reason', async () => {
    const hang = { calls: [] as string[][], run: (_c: string, args: readonly string[], o?: { signal?: AbortSignal }) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      hang.calls.push([...args]);
      if (args[0] === 'ls' || args[0] === 'ps') { resolve({ code: 0, stdout: '', stderr: '' }); return; }
      o?.signal?.addEventListener('abort', () => resolve({ code: 127, stdout: '', stderr: 'aborted' }));
    }) };
    const runner = createSbxSessionRunner({ proc: hang, core: 'claude', name: NAME, existing: [NAME], linkTimeoutMs: 20, oauth: { grants: grants(), account: 'work' } });
    const out = await runner.prepareLaunch!();
    expect(out).toEqual({ ok: false, reason: 'sbx policy allow failed: timed out' });
  });

  it('abortLaunch revokes the issued key and removes the policy rule, and a later placement is refused', async () => {
    const g = grants();
    const { runner, proc } = make(g, [], 'work');
    await runner.prepareLaunch!();
    await runner.abortLaunch!();
    expect(g.release).toHaveBeenCalledWith(NAME);
    expect(sbxCalls(proc).some((c) => c.args[0] === 'policy' && c.args[1] === 'rm')).toBe(true);
    expect(runner.guestSetupPending!()).toBe(true);
  });

  it('revokes the key and removes the policy rule before it removes the sandbox', async () => {
    const g = grants();
    const { runner, proc } = make(g, [NAME]);
    await runner.dispose!({ hostWorktreePath: '', branch: 'b' });
    expect(g.release).toHaveBeenCalledWith(NAME);
    const order = sbxCalls(proc).map((c) => c.args.slice(0, 2).join(' '));
    expect(order.indexOf('policy rm')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('policy rm')).toBeLessThan(order.indexOf('rm --force'));
  });

  it('has no prepare step without the oauth option', () => {
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [] });
    expect(runner.prepareLaunch).toBeUndefined();
  });
});
