import { describe, it, expect } from 'vitest';
import { parseIntent, buildIntentPrompt, generateIntent } from './intent.js';

const valid =
  '## Goal\nUsers can archive a ticket.\n\n## Scenarios\n- Given an open ticket, when the user clicks Archive, then it leaves the board';

function adapterFor(answers: string[]) {
  const seen: { cwd: string; site?: string; prompt: string }[] = [];
  let i = 0;
  const adapter = {
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    async runHeadless(o: any) {
      seen.push({ cwd: o.cwd, site: o.tracking?.callSite, prompt: o.prompt });
      const raw = answers[Math.min(i++, answers.length - 1)]!;
      return { sessionId: 's', verdict: null, raw };
    },
  };
  return { adapter: adapter as any, seen };
}

describe('parseIntent', () => {
  it('accepts Goal + one Given/When/Then scenario', () => expect(parseIntent(valid)).toBe(valid));
  it('strips a code fence and leading prose', () =>
    expect(parseIntent('Here:\n```md\n' + valid + '\n```')).toBe(valid));
  it('keeps an optional Not in scope section', () => {
    const t = valid + '\n\n## Not in scope\n- bulk archive';
    expect(parseIntent(t)).toBe(t);
  });
  it('rejects a missing Goal', () =>
    expect(parseIntent('## Scenarios\n- Given a, when b, then c')).toBeNull());
  it('rejects scenarios without "then"', () =>
    expect(parseIntent('## Goal\ng\n\n## Scenarios\n- user archives it')).toBeNull());
  it('rejects no scenarios', () => expect(parseIntent('## Goal\ng\n\n## Scenarios\n')).toBeNull());
  it('rejects an empty Goal', () =>
    expect(parseIntent('## Goal\n\n## Scenarios\n- Given a, when b, then c')).toBeNull());
});

describe('buildIntentPrompt', () => {
  it('forbids implementation detail and composes the shared rules', () => {
    const p = buildIntentPrompt({ title: 't', brief: 'b' });
    expect(p).toMatch(/observable/i);
    expect(p).toMatch(/no file paths/i);
    expect(p).toMatch(/is DATA/);
    expect(p).toMatch(/never fill it in/);
  });
  it('includes the improved description, author prompt and type when given', () => {
    const p = buildIntentPrompt({
      title: 't',
      improvedDescription: 'IMPROVED',
      authorPrompt: 'AUTHOR',
      ticketType: 'fix',
    });
    expect(p).toContain('IMPROVED');
    expect(p).toContain('AUTHOR');
    expect(p).toContain('Type: fix');
  });
});

describe('generateIntent', () => {
  it('returns canonical text on first valid answer, in a sandbox, call site ticket-intent', async () => {
    const { adapter, seen } = adapterFor([valid]);
    const r = await generateIntent(adapter, { title: 't', brief: 'b' });
    expect(r).toEqual({ text: valid, degraded: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cwd).toMatch(/karst-analysis-/);
    expect(seen[0]!.site).toBe('ticket-intent');
  });
  it('retries once with a reformat nudge', async () => {
    const { adapter, seen } = adapterFor(['prose', valid]);
    expect(await generateIntent(adapter, { title: 't' })).toEqual({ text: valid, degraded: false });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toMatch(/did not follow the format/);
  });
  it('invalid twice → text null, degraded true (never half-valid)', async () => {
    const { adapter } = adapterFor(['just prose']);
    expect(await generateIntent(adapter, { title: 't', brief: 'b' })).toEqual({
      text: null,
      degraded: true,
    });
  });
  it('nothing to work from → no call, text null, not degraded', async () => {
    const { adapter, seen } = adapterFor([valid]);
    expect(await generateIntent(adapter, { title: '' })).toEqual({ text: null, degraded: false });
    expect(seen).toHaveLength(0);
  });
  it('forwards model and effort', async () => {
    const calls: any[] = [];
    const adapter = {
      async runHeadless(o: any) {
        calls.push(o);
        return { sessionId: 's', verdict: null, raw: valid };
      },
    };
    await generateIntent(adapter as any, { title: 't', model: 'm', effort: 'low', ticketId: 3 });
    expect(calls[0].model).toBe('m');
    expect(calls[0].effort).toBe('low');
    expect(calls[0].tracking.ticketId).toBe(3);
  });
  it('adapter rejection degrades instead of throwing, and logs', async () => {
    const adapter = {
      async runHeadless() {
        throw new Error('rate limited');
      },
    };
    const logs: string[] = [];
    expect(await generateIntent(adapter as any, { title: 't' }, (m) => logs.push(m))).toEqual({
      text: null,
      degraded: true,
    });
    expect(logs[0]).toContain('rate limited');
  });
});
