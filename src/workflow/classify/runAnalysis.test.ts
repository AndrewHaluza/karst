import { describe, it, expect } from 'vitest';
import { runAnalysis } from './runAnalysis.js';
import { UsageLimitError } from '../../agent/cliFailure.js';

type Call = { site: string; cwd: string; prompt: string };
function routed(answers: Partial<Record<string, string | Error>>) {
  const calls: Call[] = [];
  const adapter = {
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    async runHeadless(o: any) {
      const site = o.tracking.callSite as string;
      calls.push({ site, cwd: o.cwd, prompt: o.prompt });
      const a = answers[site];
      if (a instanceof Error) throw a;
      return { sessionId: 's', verdict: null, raw: a ?? '' };
    },
  };
  return { adapter: adapter as any, calls, sites: () => calls.map((c) => c.site) };
}
const CLASSIFY = '{"prompt":"p","approach":"direct","repos":["api"],"reason":"r","type":"feat"}';
const INTENT = '## Goal\ng\n\n## Scenarios\n- Given a, when b, then c';
const POINTER = '- src/a.ts — x';
const input = (over: Record<string, unknown> = {}) => ({
  analyze: { brief: 'b', prompt: 'raw', services: [{ name: 'api', signals: [], score: 1 }], approaches: [{ id: 'direct', label: 'D' }] },
  title: 't',
  improve: { instructions: '', cwd: '/proj', resolveRepoPath: () => '/proj/api' as string | undefined },
  codePointers: { enabled: false },
  ...over,
});

describe('runAnalysis', () => {
  it('happy path: classify, improve, intent; no pointer call when disabled', async () => {
    const { adapter, sites } = routed({ 'ticket-analysis': CLASSIFY, 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT });
    const r = await runAnalysis(adapter, input());
    expect(sites()).toEqual(['ticket-analysis', 'ticket-improve', 'ticket-intent']);
    expect(r).toMatchObject({ description: 'IMPROVED', intent: INTENT, codePointers: null, degraded: [] });
  });

  it('intent receives the improved description, never pointers, and runs sandboxed', async () => {
    const { adapter, calls } = routed({
      'ticket-analysis': CLASSIFY, 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT, 'ticket-code-pointers': POINTER,
    });
    await runAnalysis(adapter, input({ codePointers: { enabled: true } }));
    const intentCall = calls.find((c) => c.site === 'ticket-intent')!;
    expect(intentCall.prompt).toContain('IMPROVED');
    expect(intentCall.prompt).not.toContain('src/a.ts');
    expect(intentCall.cwd).toMatch(/karst-analysis-/);
    expect(calls.map((c) => c.site).indexOf('ticket-intent')).toBeLessThan(calls.map((c) => c.site).indexOf('ticket-code-pointers'));
  });

  it('custom profile body still yields intent (Review Focus 1)', async () => {
    const { adapter, calls } = routed({ 'ticket-analysis': CLASSIFY, 'ticket-improve': 'PROFILE OUT', 'ticket-intent': INTENT });
    const r = await runAnalysis(adapter, input({ improve: { instructions: 'PROFILE', cwd: '/proj', resolveRepoPath: () => undefined } }));
    expect(calls.find((c) => c.site === 'ticket-improve')!.prompt).toContain('PROFILE');
    expect(r.intent).toBe(INTENT);
    expect(r.degraded).toEqual([]);
  });

  it('reports a quota failure from a degrading pass via onUsageLimit (K11)', async () => {
    const limit = new UsageLimitError('Claude usage limit reached — out of credits.', {
      tool: 'Claude',
      provider: 'claude',
    });
    const { adapter } = routed({
      'ticket-analysis': CLASSIFY,
      'ticket-improve': limit,
      'ticket-intent': INTENT,
    });
    const seen: unknown[] = [];
    const r = await runAnalysis(adapter, input({ onUsageLimit: (e: unknown) => seen.push(e) }));
    expect(seen).toEqual([limit]);
    expect(r.degraded).toContain('improve');
  });

  it('reports a quota failure from classify and still rethrows (K11)', async () => {
    const limit = new UsageLimitError('quota exceeded', { tool: 'Claude', provider: 'claude' });
    const { adapter } = routed({ 'ticket-analysis': limit });
    const seen: unknown[] = [];
    await expect(
      runAnalysis(adapter, input({ onUsageLimit: (e: unknown) => seen.push(e) })),
    ).rejects.toBe(limit);
    expect(seen).toEqual([limit]);
  });

  it('improve throws → description falls back to the classify prompt, degraded has improve', async () => {
    const { adapter } = routed({ 'ticket-analysis': CLASSIFY, 'ticket-improve': new Error('x'), 'ticket-intent': INTENT });
    const warnings: string[] = [];
    const r = await runAnalysis(adapter, input({ warn: (m: string) => warnings.push(m) }));
    expect(r.description).toBe('p');
    expect(r.degraded).toEqual(['improve']);
    expect(warnings).toHaveLength(1);
  });

  it('resolveRepoPath is called once, with the classified repos, after classify', async () => {
    const seen: string[][] = [];
    const { adapter, calls } = routed({ 'ticket-analysis': CLASSIFY, 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT });
    await runAnalysis(adapter, input({
      improve: { instructions: '', cwd: '/proj', resolveRepoPath: (repos: string[]) => { seen.push(repos); return '/proj/api'; } },
    }));
    expect(seen).toEqual([['api']]);
    expect(calls.find((c) => c.site === 'ticket-improve')!.prompt).toContain('/proj/api');
  });

  it('pointers enabled + resolvable repo → runs in that repo and returns the text (Review Focus 5)', async () => {
    const { adapter, calls } = routed({
      'ticket-analysis': CLASSIFY, 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT, 'ticket-code-pointers': POINTER,
    });
    const r = await runAnalysis(adapter, input({ codePointers: { enabled: true } }));
    const ptr = calls.find((c) => c.site === 'ticket-code-pointers')!;
    expect(ptr.cwd).toBe('/proj/api');
    expect(ptr.prompt).toContain('IMPROVED');
    expect(r.codePointers).toBe(POINTER);
    expect(r.degraded).toEqual([]);
  });

  it('pointers enabled but no repo resolvable → pass skipped, no call, no warning (Review Focus 5)', async () => {
    const { adapter, sites } = routed({ 'ticket-analysis': CLASSIFY, 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT });
    const r = await runAnalysis(adapter, input({
      codePointers: { enabled: true },
      improve: { instructions: '', cwd: '/proj', resolveRepoPath: () => undefined },
    }));
    expect(sites()).not.toContain('ticket-code-pointers');
    expect(r.codePointers).toBeNull();
    expect(r.degraded).toEqual([]);
  });

  it('a valid empty pointer answer is not degraded', async () => {
    const { adapter } = routed({
      'ticket-analysis': CLASSIFY, 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT, 'ticket-code-pointers': '',
    });
    const r = await runAnalysis(adapter, input({ codePointers: { enabled: true } }));
    expect(r.codePointers).toBeNull();
    expect(r.degraded).toEqual([]);
  });

  it('a pointer adapter failure is degraded as code-pointers', async () => {
    const { adapter } = routed({
      'ticket-analysis': CLASSIFY, 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT, 'ticket-code-pointers': new Error('boom'),
    });
    const r = await runAnalysis(adapter, input({ codePointers: { enabled: true } }));
    expect(r.codePointers).toBeNull();
    expect(r.degraded).toEqual(['code-pointers']);
  });

  it('intent invalid twice → intent null and degraded has intent', async () => {
    const { adapter, sites } = routed({ 'ticket-analysis': CLASSIFY, 'ticket-improve': 'IMPROVED', 'ticket-intent': 'just prose' });
    const r = await runAnalysis(adapter, input());
    expect(r.intent).toBeNull();
    expect(r.degraded).toEqual(['intent']);
    expect(sites().filter((s) => s === 'ticket-intent')).toHaveLength(2);
  });

  it('classify prose twice → fallbacks apply and degraded names classify, first (Review Focus 2)', async () => {
    const { adapter, sites } = routed({ 'ticket-analysis': 'prose', 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT });
    const r = await runAnalysis(adapter, input());
    expect(sites().filter((s) => s === 'ticket-analysis')).toHaveLength(2);
    expect(r.degraded).toEqual(['classify']);
    expect(r.classification.repos).toEqual(['api']);
    expect(r.description).toBe('IMPROVED');
  });

  it('fresh ticket: classified type "fix" drives bug shape in improve and Type in intent', async () => {
    const { adapter, calls } = routed({
      'ticket-analysis': CLASSIFY.replace('"type":"feat"', '"type":"fix"'), 'ticket-improve': 'IMPROVED', 'ticket-intent': INTENT,
    });
    await runAnalysis(adapter, input());
    expect(calls.find((c) => c.site === 'ticket-improve')!.prompt).toMatch(/\*\*Actual:\*\*/);
    expect(calls.find((c) => c.site === 'ticket-intent')!.prompt).toContain('Type: fix');
  });

  it('classify adapter rejection propagates (the caller closes the run as failed)', async () => {
    const { adapter, sites } = routed({ 'ticket-analysis': new Error('boom') });
    await expect(runAnalysis(adapter, input())).rejects.toThrow('boom');
    expect(sites()).toEqual(['ticket-analysis']);
  });
});
