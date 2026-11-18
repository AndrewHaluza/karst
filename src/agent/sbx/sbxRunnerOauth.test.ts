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

  it('puts the same pairs on a create and on a reattach', async () => {
    for (const existing of [[], [NAME]]) {
      const { runner } = make(grants(), existing);
      await runner.prepareLaunch!();
      const args = runner.placeInteractive(spec).shellArgs;
      expect(args).toContain('ANTHROPIC_BASE_URL=http://host.docker.internal:8787');
      expect(args.includes('--clone')).toBe(existing.length === 0);
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
