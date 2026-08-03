import { describe, it, expect, vi } from 'vitest';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { AggregateEntry } from './aggregate.js';
import { buildFindingsPrompt, planAndRunFindingsLane, runFindingsLane } from './findingsLane.js';

function adapter(raw: string | (() => Promise<string>)): AgentAdapter {
  return {
    requiredBinary: 'fake',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => {
      throw new Error('not used');
    },
    runHeadless: async () => {
      const value = typeof raw === 'function' ? await raw() : raw;
      return { sessionId: '', verdict: null, raw: value };
    },
  };
}

const CONFIG = { enabled: true, blockingSeverity: 'high' as const, maxFindings: 50 };
const DISABLED = { ...CONFIG, enabled: false };

const TARGET = { repo: '/web', worktreePath: '/wt/web' };

function entry(exitCode: number | null): AggregateEntry {
  return {
    result: { name: 'lint (web)', exitCode, output: '' },
    identity: { repo: '/web', command: 'npm', args: ['run', 'lint'] },
  };
}

describe('runFindingsLane', () => {
  it('reports not-run when the config is disabled, without calling the adapter', async () => {
    const runHeadless = vi.fn();
    const outcome = await runFindingsLane({
      config: DISABLED,
      adapter: { ...adapter('[]'), runHeadless },
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'not-run' });
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it('reports capability-missing when no adapter is available', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({
      kind: 'capability-missing',
      reason: 'review findings: no agent core is available to ask about the diff',
    });
  });

  it('parses a clean JSON array response into findings, tagged with the target repo', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(JSON.stringify([{ severity: 'medium', title: 'x', detail: 'y' }])),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({
      kind: 'ran',
      findings: [{ severity: 'medium', repo: '/web', file: null, line: null, title: 'x', detail: 'y', source: 'agent' }],
    });
  });

  it("threads the target's base ref into the prompt sent to the adapter", async () => {
    let capturedPrompt: string | undefined;
    const runHeadless = vi.fn(async (headlessOpts: { prompt: string }) => {
      capturedPrompt = headlessOpts.prompt;
      return { sessionId: '', verdict: null, raw: '[]' };
    });
    await runFindingsLane({
      config: CONFIG,
      adapter: { ...adapter('[]'), runHeadless },
      targets: [{ repo: '/web', worktreePath: '/wt/web', baseRef: 'develop' }],
      ticketId: 1,
    });
    expect(runHeadless).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toContain('develop');
  });

  it('a failed call contributes no findings for that target but does not throw', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(() => Promise.reject(new Error('boom'))),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [] });
  });

  // Finding 1: a failed/rejected call must not be silent — the lane still
  // degrades to `ran` with no findings (the call must never break the
  // stage), but the failure is described and reported through `warn` rather
  // than swallowed, so a broken lane is distinguishable from a clean review.
  it('warns with a one-line, capped description of a rejected call, and still reports ran/no findings', async () => {
    const warn = vi.fn();
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(() => Promise.reject(new Error('boom'))),
      targets: [TARGET],
      ticketId: 1,
      warn,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('/web');
    expect(message).toContain('boom');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThanOrEqual(8_000);
  });

  it('collapses a multi-line, oversized failure message to one capped line before warning', async () => {
    const warn = vi.fn();
    const huge = `first line\nsecond line\n${'x'.repeat(9_000)}`;
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(() => Promise.reject(new Error(huge))),
      targets: [TARGET],
      ticketId: 1,
      warn,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).not.toContain('\n');
    // The raw failure text was collapsed-then-capped before it was folded into
    // the warn line, so the whole message stays well short of the input size.
    expect(message.length).toBeLessThan(huge.length);
  });

  it('threads a supplied warn into parseFindings for a real lane run, never the console', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warn = vi.fn();
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter('not json at all'),
      targets: [TARGET],
      ticketId: 1,
      warn,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('not recognizable JSON');
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('a garbage response parses to zero findings, not a thrown error', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter('not json at all'),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [] });
  });

  it('asks every target and combines what each one reports', async () => {
    const calls: string[] = [];
    const a: AgentAdapter = {
      ...adapter('[]'),
      runHeadless: async (opts) => {
        calls.push(opts.cwd);
        const severity = opts.cwd === '/wt/web' ? 'high' : 'low';
        return { sessionId: '', verdict: null, raw: JSON.stringify([{ severity, title: 't', detail: '' }]) };
      },
    };
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: a,
      targets: [TARGET, { repo: '/api', worktreePath: '/wt/api' }],
      ticketId: 1,
    });
    expect(calls).toEqual(['/wt/web', '/wt/api']);
    expect(outcome.kind).toBe('ran');
    expect(outcome.kind === 'ran' && outcome.findings.map((f) => f.severity)).toEqual(['high', 'low']);
  });

  it('stops asking further targets once the signal is already aborted', async () => {
    const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    const controller = new AbortController();
    controller.abort();
    await runFindingsLane({
      config: CONFIG,
      adapter: { ...adapter('[]'), runHeadless },
      targets: [TARGET, { repo: '/api', worktreePath: '/wt/api' }],
      ticketId: 1,
      signal: controller.signal,
    });
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it('declares its call site and ticket so token spend is attributable', async () => {
    let seenTracking: unknown;
    const a: AgentAdapter = {
      ...adapter('[]'),
      runHeadless: async (opts) => {
        seenTracking = opts.tracking;
        return { sessionId: '', verdict: null, raw: '[]' };
      },
    };
    await runFindingsLane({ config: CONFIG, adapter: a, targets: [TARGET], ticketId: 42 });
    expect(seenTracking).toEqual({ callSite: 'review-findings', ticketId: 42 });
  });
});

describe('planAndRunFindingsLane', () => {
  it('skips the AI call entirely when a gate already failed (R5 wins, spec §8.14)', async () => {
    const runHeadless = vi.fn();
    const { outcome } = await planAndRunFindingsLane({
      entries: [entry(1)],
      targets: [TARGET],
      findingsConfig: CONFIG,
      adapter: { ...adapter('[]'), runHeadless },
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'not-run' });
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it('runs the lane once gates leave the outcome undecided, using the default config when none is given', async () => {
    const { outcome, blockingSeverity } = await planAndRunFindingsLane({
      entries: [entry(0)],
      targets: [TARGET],
      adapter: adapter('[]'),
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [] });
    expect(blockingSeverity).toBe('high'); // DEFAULT_REVIEW_FINDINGS
  });

  it('threads a supplied warn down into the lane it runs', async () => {
    const warn = vi.fn();
    const { outcome } = await planAndRunFindingsLane({
      entries: [entry(0)],
      targets: [TARGET],
      adapter: adapter(() => Promise.reject(new Error('boom'))),
      ticketId: 1,
      warn,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('boom');
  });
});

describe('buildFindingsPrompt', () => {
  it('names the target repository and asks for JSON only', () => {
    const prompt = buildFindingsPrompt('/web');
    expect(prompt).toContain('/web');
    expect(prompt).toContain('JSON array');
  });

  // `worktrees.base_ref` is already in hand at the call site (`stages/review.ts`)
  // — without naming it, a wrong diff range can fail a ticket over an
  // unrelated commit at the shipped `blockingSeverity: 'high'`.
  it('names the base branch when one is known', () => {
    const prompt = buildFindingsPrompt('/web', 'develop');
    expect(prompt).toContain('develop');
    expect(prompt).not.toContain('its base branch.');
  });

  // A missing base ref must degrade to the prior, generic wording — never emit
  // the literal string "undefined" into a prompt an agent will read.
  it('falls back to the generic wording when the base ref is unknown', () => {
    const withNull = buildFindingsPrompt('/web', null);
    const withUndefined = buildFindingsPrompt('/web');
    expect(withNull).not.toContain('undefined');
    expect(withUndefined).not.toContain('undefined');
    expect(withNull).toContain('its base branch.');
    expect(withUndefined).toContain('its base branch.');
  });
});
