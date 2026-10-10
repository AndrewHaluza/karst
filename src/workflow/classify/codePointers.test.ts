import { describe, it, expect } from 'vitest';
import { parseCodePointers, generateCodePointers } from './codePointers.js';

function adapterFor(outcome: string | Error) {
  const calls: { cwd: string; site?: string; prompt: string }[] = [];
  const adapter = {
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    async runHeadless(o: any) {
      calls.push({ cwd: o.cwd, site: o.tracking?.callSite, prompt: o.prompt });
      if (outcome instanceof Error) throw outcome;
      return { sessionId: 's', verdict: null, raw: outcome };
    },
  };
  return { adapter: adapter as any, calls };
}
const input = { title: 't', description: 'IMPROVED DESC', repoPath: '/repo' };

describe('parseCodePointers', () => {
  it('keeps only "- path[:line] — reason" lines, max 8', () => {
    const raw =
      'Sure!\n- src/a.ts:12 — renders the badge\n- not a pointer\n' +
      Array.from({ length: 10 }, (_, i) => `- src/f${i}.ts — r`).join('\n');
    const out = parseCodePointers(raw)!.split('\n');
    expect(out[0]).toBe('- src/a.ts:12 — renders the badge');
    expect(out).toHaveLength(8);
  });
  it('returns null when nothing parses', () => expect(parseCodePointers('no idea')).toBeNull());
});

describe('generateCodePointers', () => {
  it('runs in the repo path with call site ticket-code-pointers', async () => {
    const { adapter, calls } = adapterFor('- src/a.ts — x');
    const r = await generateCodePointers(adapter, input);
    expect(r).toEqual({ text: '- src/a.ts — x', degraded: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/repo');
    expect(calls[0]!.site).toBe('ticket-code-pointers');
    expect(calls[0]!.prompt).toContain('IMPROVED DESC');
    expect(calls[0]!.prompt).toMatch(/is DATA/);
  });
  it('a valid empty answer is NOT degraded', async () => {
    const { adapter } = adapterFor('');
    expect(await generateCodePointers(adapter, input)).toEqual({ text: null, degraded: false });
  });
  it('an unparseable answer is NOT degraded', async () => {
    const { adapter } = adapterFor('I could not find anything.');
    expect(await generateCodePointers(adapter, input)).toEqual({ text: null, degraded: false });
  });
  it('adapter rejection resolves to degraded true and logs', async () => {
    const { adapter } = adapterFor(new Error('rate limited'));
    const logs: string[] = [];
    expect(await generateCodePointers(adapter, input, (m) => logs.push(m))).toEqual({
      text: null,
      degraded: true,
    });
    expect(logs[0]).toContain('rate limited');
  });
  it('forwards model and effort', async () => {
    const seen: any[] = [];
    const adapter = {
      async runHeadless(o: any) {
        seen.push(o);
        return { sessionId: 's', verdict: null, raw: '' };
      },
    };
    await generateCodePointers(adapter as any, { ...input, model: 'm', effort: 'low' });
    expect(seen[0].model).toBe('m');
    expect(seen[0].effort).toBe('low');
  });
});
