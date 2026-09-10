import { describe, it, expect, vi } from 'vitest';
import type {
  AgentAdapter,
  HeadlessResult,
  InteractiveCommand,
  Materialized,
  RunHeadlessOpts,
} from './adapter.js';
import {
  resilientAdapter,
  backoffDelay,
  type ResilienceOptions,
  type ModelFallbackEvent,
} from './resilientAdapter.js';

function fakeAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    requiredBinary: 'fake',
    capabilities: { lifecycleEvents: true, resume: true },
    runHeadless: overrides.runHeadless ?? (async (): Promise<HeadlessResult> => ({
      sessionId: 's1',
      verdict: null,
      raw: 'answer',
    })),
    buildInteractiveCommand: (): InteractiveCommand => ({
      command: 'fake',
      args: ['--go'],
      env: {},
    }),
    ...overrides,
  };
}

function opts(
  overrides: Partial<ResilienceOptions> = {},
): ResilienceOptions {
  return {
    retries: 2,
    backoffMs: 2000,
    chain: () => ['a'],
    random: () => 0.5,
    ...overrides,
  };
}

const INCIDENT_ERROR = new Error(
  'opencode reported an error: {"name":"APIError","data":{"message":"Bad Request: {\\"object\\":\\"error\\",\\"model\\":\\"deepseek-v4-flash\\"}","statusCode":400,"isRetryable":false}}',
);

describe('backoffDelay', () => {
  it('returns baseMs for attempt 1 with zero jitter', () => {
    expect(backoffDelay(2000, 1, () => 0.5)).toBe(2000);
  });

  it('doubles for attempt 2', () => {
    expect(backoffDelay(2000, 2, () => 0.5)).toBe(4000);
  });

  it('doubles again for attempt 3', () => {
    expect(backoffDelay(2000, 3, () => 0.5)).toBe(8000);
  });

  it('applies -20% jitter when random returns 0', () => {
    expect(backoffDelay(2000, 1, () => 0)).toBe(1600);
  });

  it('applies +20% jitter when random returns 1', () => {
    expect(backoffDelay(2000, 1, () => 1)).toBe(2400);
  });

  it('caps at 60000', () => {
    expect(backoffDelay(60000, 5, () => 1)).toBe(60000);
  });
});

describe('resilientAdapter', () => {
  it('happy path: inner succeeds first call', async () => {
    const spy = vi.fn(async (): Promise<HeadlessResult> => ({
      sessionId: 's1', verdict: null, raw: 'answer',
    }));
    const inner = fakeAdapter({ runHeadless: spy });
    const adapter = resilientAdapter(inner, opts());
    const result = await adapter.runHeadless({ prompt: 'hi', cwd: '.' });
    expect(result.raw).toBe('answer');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('transient then success', async () => {
    let calls = 0;
    const spy = vi.fn(async (): Promise<HeadlessResult> => {
      calls++;
      if (calls === 1) throw new Error('503 upstream');
      return { sessionId: 's1', verdict: null, raw: 'ok' };
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const sleep = vi.fn(async () => {});
    const adapter = resilientAdapter(inner, opts({ sleep }));

    const result = await adapter.runHeadless({ prompt: 'hi', cwd: '.' });
    expect(result.raw).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
  });

  it('transient exhausted, no fallback', async () => {
    const spy = vi.fn(async () => { throw new Error('503 upstream'); });
    const inner = fakeAdapter({ runHeadless: spy });
    const sleep = vi.fn(async () => {});
    const adapter = resilientAdapter(inner, opts({ sleep, retries: 2, chain: () => ['a'] }));

    await expect(adapter.runHeadless({ prompt: 'hi', cwd: '.' })).rejects.toThrow('503');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c: readonly unknown[]) => c[0])).toEqual([2000, 4000]);
  });

  it('model-rejected hops immediately (K4)', async () => {
    let calls = 0;
    const spy = vi.fn(async (runOpts: RunHeadlessOpts): Promise<HeadlessResult> => {
      calls++;
      if (runOpts.model === 'a') throw INCIDENT_ERROR;
      return { sessionId: 's1', verdict: null, raw: 'ok' };
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const sleep = vi.fn(async () => {});
    const adapter = resilientAdapter(inner, opts({
      sleep,
      retries: 2,
      chain: () => ['a', 'b'],
    }));

    const result = await adapter.runHeadless({ prompt: 'hi', cwd: '.' });
    expect(result.raw).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('the hop notifies once with the right facts', async () => {
    let calls = 0;
    const spy = vi.fn(async (runOpts: RunHeadlessOpts): Promise<HeadlessResult> => {
      calls++;
      if (runOpts.model === 'a') throw INCIDENT_ERROR;
      return { sessionId: 's1', verdict: null, raw: 'ok' };
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const notify = vi.fn();
    const adapter = resilientAdapter(inner, opts({
      retries: 0,
      chain: () => ['a', 'b'],
      notify,
    }));

    await adapter.runHeadless({
      prompt: 'hi',
      cwd: '.',
      tracking: { callSite: 'review-findings', ticketId: 42 },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      callSite: 'review-findings',
      ticketId: 42,
      fromModel: 'a',
      toModel: 'b',
      failureClass: 'model-rejected',
    });
  });

  it('a throwing notify does not break the call', async () => {
    let calls = 0;
    const spy = vi.fn(async (runOpts: RunHeadlessOpts): Promise<HeadlessResult> => {
      calls++;
      if (runOpts.model === 'a') throw INCIDENT_ERROR;
      return { sessionId: 's1', verdict: null, raw: 'ok' };
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const adapter = resilientAdapter(inner, opts({
      retries: 0,
      chain: () => ['a', 'b'],
      notify: () => { throw new Error('notify broken'); },
    }));

    const result = await adapter.runHeadless({ prompt: 'hi', cwd: '.' });
    expect(result.raw).toBe('ok');
  });

  it('fallback after transient exhaustion', async () => {
    let callsA = 0;
    let callsB = 0;
    const spy = vi.fn(async (runOpts: RunHeadlessOpts): Promise<HeadlessResult> => {
      if (runOpts.model === 'a') {
        callsA++;
        throw new Error('503 upstream');
      }
      callsB++;
      return { sessionId: 's1', verdict: null, raw: 'ok' };
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const sleep = vi.fn(async () => {});
    const notify = vi.fn();
    const adapter = resilientAdapter(inner, opts({
      sleep,
      retries: 1,
      chain: () => ['a', 'b'],
      notify,
    }));

    const result = await adapter.runHeadless({ prompt: 'hi', cwd: '.' });
    expect(result.raw).toBe('ok');
    expect(callsA).toBe(2);
    expect(callsB).toBe(1);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].failureClass).toBe('transient');
  });

  it('abort is never retried', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const spy = vi.fn(async () => { throw abortErr; });
    const inner = fakeAdapter({ runHeadless: spy });
    const adapter = resilientAdapter(inner, opts());

    await expect(adapter.runHeadless({ prompt: 'hi', cwd: '.' })).rejects.toBe(abortErr);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('timeout is never retried', async () => {
    const spy = vi.fn(async () => {
      throw new Error('headless agent run timed out after 900000ms');
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const adapter = resilientAdapter(inner, opts());

    await expect(adapter.runHeadless({ prompt: 'hi', cwd: '.' })).rejects.toThrow('timed out');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fatal is never retried', async () => {
    const spy = vi.fn(async () => {
      throw new Error('401 Unauthorized');
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const adapter = resilientAdapter(inner, opts());

    await expect(adapter.runHeadless({ prompt: 'hi', cwd: '.' })).rejects.toThrow('401');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('chain exhausted rethrows the LAST error', async () => {
    const errA = new Error('503 fail-a');
    const errB = new Error('503 fail-b');
    let calls = 0;
    const spy = vi.fn(async (): Promise<HeadlessResult> => {
      calls++;
      if (calls <= 1) throw errA;
      throw errB;
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const adapter = resilientAdapter(inner, opts({
      retries: 0,
      chain: () => ['a', 'b'],
    }));

    await expect(adapter.runHeadless({ prompt: 'hi', cwd: '.' })).rejects.toBe(errB);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('the CLI-default chain entry omits the model key', async () => {
    let seenOpts: RunHeadlessOpts | undefined;
    const spy = vi.fn(async (runOpts: RunHeadlessOpts): Promise<HeadlessResult> => {
      seenOpts = runOpts;
      return { sessionId: 's1', verdict: null, raw: 'ok' };
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const adapter = resilientAdapter(inner, opts({
      retries: 0,
      chain: () => [undefined, 'b'],
    }));

    await adapter.runHeadless({ prompt: 'hi', cwd: '.' });
    expect(seenOpts).toBeDefined();
    expect('model' in seenOpts!).toBe(false);
  });

  it('abort during backoff propagates', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const spy = vi.fn(async () => { throw new Error('503 upstream'); });
    const inner = fakeAdapter({ runHeadless: spy });
    const sleep = vi.fn(async () => { throw abortErr; });
    const adapter = resilientAdapter(inner, opts({ sleep }));

    await expect(adapter.runHeadless({ prompt: 'hi', cwd: '.' })).rejects.toBe(abortErr);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('delegation: buildInteractiveCommand, requiredBinary, capabilities, surfaces', () => {
    const materializeApproach = vi.fn((): Materialized => ({ extraArgs: [], ownedPaths: [] }));
    const inner = fakeAdapter({
      materializeApproach,
      surfaces: { structuredOutput: 'unsupported' } as any,
    });
    const adapter = resilientAdapter(inner, opts());

    expect(adapter.requiredBinary).toBe('fake');
    expect(adapter.capabilities).toEqual(inner.capabilities);
    expect(adapter.buildInteractiveCommand({ cwd: '/w' }).args).toEqual(['--go']);
    expect(adapter.surfaces).toEqual({ structuredOutput: 'unsupported' });
    adapter.materializeApproach?.({
      pkg: { id: 'p', label: 'P' },
      baseDir: '/b',
      sessionDir: '/s',
    });
    expect(materializeApproach).toHaveBeenCalled();
  });

  it('materializeApproach is absent when the inner adapter has none', () => {
    const adapter = resilientAdapter(fakeAdapter(), opts());
    expect(adapter.materializeApproach).toBeUndefined();
  });

  it('notify is not called for a same-model retry', async () => {
    let calls = 0;
    const spy = vi.fn(async (): Promise<HeadlessResult> => {
      calls++;
      if (calls === 1) throw new Error('503 upstream');
      return { sessionId: 's1', verdict: null, raw: 'ok' };
    });
    const inner = fakeAdapter({ runHeadless: spy });
    const notify = vi.fn();
    const adapter = resilientAdapter(inner, opts({
      retries: 1,
      chain: () => ['a'],
      notify,
    }));

    await adapter.runHeadless({ prompt: 'hi', cwd: '.' });
    expect(notify).not.toHaveBeenCalled();
  });
});
