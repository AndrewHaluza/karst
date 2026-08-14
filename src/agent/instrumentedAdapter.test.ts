import { describe, it, expect, vi } from 'vitest';
import type {
  AgentAdapter,
  HeadlessResult,
  InteractiveCommand,
  Materialized,
  RunHeadlessOpts,
} from './adapter.js';
import { instrumentAdapter, type UsageSink } from './instrumentedAdapter.js';
import { attachUsage } from './tokenUsage.js';
import type { TokenUsageEntry } from '../store/tokenUsage.js';

const CLAUDE_ENVELOPE_USAGE = {
  inputTokens: 120,
  outputTokens: 45,
  reasoningTokens: 0,
  cacheReadTokens: 900,
  cacheWriteTokens: 30,
  totalTokens: 1095,
  model: 'claude-opus-5',
  estimated: false,
};

function sink(): UsageSink & { entries: TokenUsageEntry[] } {
  const entries: TokenUsageEntry[] = [];
  return { entries, record: (e) => entries.push(e) };
}

function fakeAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    requiredBinary: 'fake',
    capabilities: { lifecycleEvents: true, resume: true },
    runHeadless: async (): Promise<HeadlessResult> => ({
      sessionId: 's1',
      verdict: null,
      raw: 'answer',
      usage: { ...CLAUDE_ENVELOPE_USAGE },
    }),
    buildInteractiveCommand: (): InteractiveCommand => ({
      command: 'fake',
      args: ['--go'],
      env: {},
    }),
    ...overrides,
  };
}

describe('instrumentAdapter', () => {
  it('injects the host debug callback into every headless call', async () => {
    const s = sink();
    let seenDebug: ((message: string) => void) | undefined;
    const inner = fakeAdapter({
      runHeadless: async (opts) => {
        seenDebug = opts.debug;
        return { sessionId: 's1', verdict: null, raw: 'answer' };
      },
    });
    const adapter = instrumentAdapter(inner, {
      sink: s,
      debug: (message: string) => message.toLowerCase(),
    });

    await adapter.runHeadless({ prompt: 'hi', cwd: '.' });

    // The adapter's own debug lines are bound ONCE here — a new AI integration
    // gets debug logging by construction, not by threading at every call site.
    expect(seenDebug).toBeDefined();
    expect(seenDebug!('[AGENT:CLAUDE] x')).toBe('[agent:claude] x');
  });

  it('records the provider-reported counts under the declared call site and ticket', async () => {
    const s = sink();
    const adapter = instrumentAdapter(fakeAdapter(), {
      sink: s,
      provider: 'claude',
      projectId: () => 7,
      now: () => '2026-08-01T00:00:00.000Z',
    });

    await adapter.runHeadless({
      prompt: 'hi',
      cwd: '.',
      tracking: { callSite: 'pr-description', ticketId: 42 },
    });

    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toEqual({
      projectId: 7,
      ticketId: 42,
      processRunId: null,
      approachPlannerRunId: null,
      approachNodeRunId: null,
      callSite: 'pr-description',
      provider: 'claude',
      outcome: 'ok',
      recordedAt: '2026-08-01T00:00:00.000Z',
      usage: CLAUDE_ENVELOPE_USAGE,
    });
  });

  it('threads the process run id through to the recorded entry', async () => {
    const s = sink();
    const adapter = instrumentAdapter(fakeAdapter(), {
      sink: s,
      provider: 'claude',
    });

    await adapter.runHeadless({
      prompt: 'hi',
      cwd: '.',
      tracking: { callSite: 'fix-resume', ticketId: 9, processRunId: 12 },
    });

    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ ticketId: 9, processRunId: 12 });
  });

  it('files a call that declared no site under the undeclared site, never dropping it', async () => {
    const s = sink();
    const adapter = instrumentAdapter(fakeAdapter(), { sink: s });
    await adapter.runHeadless({ prompt: 'hi', cwd: '.' });
    expect(s.entries[0]!.callSite).toBe('unknown');
    expect(s.entries[0]!.ticketId).toBeNull();
  });

  it('falls back to a MARKED estimate only when the core reported nothing', async () => {
    const s = sink();
    const adapter = instrumentAdapter(
      fakeAdapter({
        runHeadless: async () => ({ sessionId: '', verdict: null, raw: 'b'.repeat(40) }),
      }),
      { sink: s },
    );
    await adapter.runHeadless({ prompt: 'a'.repeat(400), cwd: '.' });
    expect(s.entries[0]!.usage.estimated).toBe(true);
    expect(s.entries[0]!.usage.inputTokens).toBe(100);
    expect(s.entries[0]!.usage.outputTokens).toBe(10);
  });

  it('names the launch model when the core reported counts but no model', async () => {
    const s = sink();
    const adapter = instrumentAdapter(
      fakeAdapter({
        runHeadless: async () => ({
          sessionId: '',
          verdict: null,
          raw: 'x',
          usage: { ...CLAUDE_ENVELOPE_USAGE, model: null },
        }),
      }),
      { sink: s },
    );
    await adapter.runHeadless({ prompt: 'hi', cwd: '.', model: 'codex-mini' });
    expect(s.entries[0]!.usage.model).toBe('codex-mini');
  });

  it('keeps the counts of a call that errored AFTER the provider reported them', async () => {
    const s = sink();
    const boom = attachUsage(new Error('Claude usage limit reached.'), {
      ...CLAUDE_ENVELOPE_USAGE,
    });
    const adapter = instrumentAdapter(
      fakeAdapter({
        runHeadless: async () => {
          throw boom;
        },
      }),
      { sink: s },
    );

    await expect(
      adapter.runHeadless({ prompt: 'hi', cwd: '.', tracking: { callSite: 'fix-resume' } }),
    ).rejects.toThrow('usage limit');

    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.outcome).toBe('error');
    expect(s.entries[0]!.callSite).toBe('fix-resume');
    expect(s.entries[0]!.usage.totalTokens).toBe(1095);
  });

  it('still records an errored call the provider said nothing about, as an estimate', async () => {
    const s = sink();
    const adapter = instrumentAdapter(
      fakeAdapter({
        runHeadless: async () => {
          throw new Error('spawn ENOENT');
        },
      }),
      { sink: s },
    );
    await expect(adapter.runHeadless({ prompt: 'a'.repeat(80), cwd: '.' })).rejects.toThrow();
    expect(s.entries[0]!.usage.estimated).toBe(true);
    expect(s.entries[0]!.usage.inputTokens).toBe(20);
    expect(s.entries[0]!.usage.outputTokens).toBe(0);
  });

  it('never lets a tracking failure break the AI call it was measuring', async () => {
    const logError = vi.fn();
    const adapter = instrumentAdapter(fakeAdapter(), {
      sink: {
        record: () => {
          throw new Error('database is locked');
        },
      },
      logError,
    });

    await expect(adapter.runHeadless({ prompt: 'hi', cwd: '.' })).resolves.toMatchObject({
      raw: 'answer',
    });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![0]).toMatch(/token usage/i);
  });

  it('rethrows the original failure even when tracking it also fails', async () => {
    const logError = vi.fn();
    const adapter = instrumentAdapter(
      fakeAdapter({
        runHeadless: async () => {
          throw new Error('Claude failed (exit 2): boom');
        },
      }),
      {
        sink: {
          record: () => {
            throw new Error('database is locked');
          },
        },
        logError,
      },
    );
    await expect(adapter.runHeadless({ prompt: 'hi', cwd: '.' })).rejects.toThrow('boom');
    expect(logError).toHaveBeenCalled();
  });

  it('stores no prompt or completion text on the recorded entry', async () => {
    const s = sink();
    const adapter = instrumentAdapter(fakeAdapter(), { sink: s });
    await adapter.runHeadless({ prompt: 'SECRET PROMPT', cwd: '.' });
    expect(JSON.stringify(s.entries[0])).not.toMatch(/SECRET PROMPT|answer/);
  });

  it('passes the call through unchanged apart from the tracking', async () => {
    const runHeadless = vi.fn(async (_opts: RunHeadlessOpts) => ({
      sessionId: 'sess',
      verdict: null,
      raw: 'body',
      usage: { ...CLAUDE_ENVELOPE_USAGE },
    }));
    const adapter = instrumentAdapter(fakeAdapter({ runHeadless }), { sink: sink() });
    const opts: RunHeadlessOpts = { prompt: 'p', cwd: '/w', resume: 'r', model: 'm' };
    const result = await adapter.runHeadless(opts);
    expect(runHeadless).toHaveBeenCalledWith(opts);
    expect(result.raw).toBe('body');
    expect(result.sessionId).toBe('sess');
  });

  it('delegates every non-headless part of the adapter contract', () => {
    const materializeApproach = vi.fn((): Materialized => ({ extraArgs: [], ownedPaths: [] }));
    const inner = fakeAdapter({ materializeApproach });
    const adapter = instrumentAdapter(inner, { sink: sink() });
    expect(adapter.requiredBinary).toBe('fake');
    expect(adapter.capabilities).toEqual(inner.capabilities);
    expect(adapter.buildInteractiveCommand({ cwd: '/w' }).args).toEqual(['--go']);
    adapter.materializeApproach?.({
      pkg: { id: 'p', label: 'P' },
      baseDir: '/b',
      sessionDir: '/s',
    });
    expect(materializeApproach).toHaveBeenCalled();
  });

  it('omits materializeApproach when the wrapped adapter has none — a bare launch stays bare', () => {
    const adapter = instrumentAdapter(fakeAdapter(), { sink: sink() });
    expect(adapter.materializeApproach).toBeUndefined();
  });
});
