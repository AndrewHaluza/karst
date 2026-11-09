import { describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeCoreScript } from './fakeCore.js';

const usage = { inputTokens: 5, outputTokens: 7, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, model: null, estimated: false };

describe('FakeAdapter', () => {
  it('answers headless runs deterministically with no usage', async () => {
    const a = new FakeAdapter();
    const r1 = await a.runHeadless({ prompt: 'x', cwd: '/tmp' });
    const r2 = await a.runHeadless({ prompt: 'y', cwd: '/tmp' });
    expect(r1).toEqual(r2);
    expect(r1.sessionId).toBe('fake-session');
    expect(r1.verdict).toBeNull();
    expect(r1.usage).toBeUndefined();
  });

  it('builds an inert interactive command', () => {
    const cmd = new FakeAdapter().buildInteractiveCommand();
    expect(cmd.command).toBe('node');
    expect(cmd.env).toEqual({});
  });

  it('declares no lifecycle or resume support', () => {
    expect(new FakeAdapter().capabilities).toEqual({ lifecycleEvents: false, resume: false });
  });
});

describe('FakeAdapter scripted headless answers', () => {
  const script: FakeCoreScript = {
    headless: [
      { promptIncludes: 'REVIEW', answers: [{ raw: 'narration {"a":1}' }, { raw: '{"findings":[]}', verdict: 'ok', usage }] },
      { promptIncludes: 'TEST', answers: [{ raw: '' }] },
    ],
  };
  const run = (a: FakeAdapter, prompt: string) => a.runHeadless({ prompt, cwd: '/tmp' });

  it('answers with the first rule whose promptIncludes is a substring of the prompt', async () => {
    const r = await run(new FakeAdapter(script), 'please REVIEW and TEST this');
    expect(r.raw).toBe('narration {"a":1}');
    expect(r.verdict).toBeNull();
    expect(r.sessionId).toBe('fake-session');
  });

  it('uses the answers of a rule in order and repeats the last one', async () => {
    const a = new FakeAdapter(script);
    const raws = [];
    for (let i = 0; i < 3; i++) raws.push((await run(a, 'REVIEW')).raw);
    expect(raws).toEqual(['narration {"a":1}', '{"findings":[]}', '{"findings":[]}']);
  });

  it('returns verbatim raw, the verdict and the usage of the answer', async () => {
    const a = new FakeAdapter(script);
    await run(a, 'REVIEW');
    const r = await run(a, 'REVIEW');
    expect(r).toMatchObject({ raw: '{"findings":[]}', verdict: 'ok', usage });
  });

  it('keeps an empty raw answer empty', async () => {
    expect((await run(new FakeAdapter(script), 'TEST')).raw).toBe('');
  });

  it('keeps a separate answer counter for each rule', async () => {
    const a = new FakeAdapter(script);
    await run(a, 'REVIEW');
    expect((await run(a, 'TEST')).raw).toBe('');
    expect((await run(a, 'REVIEW')).raw).toBe('{"findings":[]}');
  });

  it('returns the stub answer when no rule matches', async () => {
    const r = await run(new FakeAdapter(script), 'something else');
    expect(r).toEqual(await run(new FakeAdapter(), 'x'));
  });

  it('reports the rule and answer index of each scripted call, and no prompt text', async () => {
    const hits: unknown[] = [];
    const a = new FakeAdapter(script, (h) => hits.push(h));
    await run(a, 'REVIEW secret prompt');
    await run(a, 'REVIEW');
    await run(a, 'no match');
    expect(hits).toEqual([{ rule: 0, answer: 0 }, { rule: 0, answer: 1 }]);
  });
});

