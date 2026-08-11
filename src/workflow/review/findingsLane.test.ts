import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicketFlow } from '../stages/create.js';
import { listProcessRuns } from '../../store/processRuns.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { AggregateEntry } from './aggregate.js';
import { buildFindingsPrompt, planAndRunFindingsLane, runFindingsLane } from './findingsLane.js';
import { GATE_LANE_HEADLESS_TIMEOUT_MS } from '../../agent/headlessSpawn.js';

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

  it('emits debug lines at entry, per target, and at exit — never the prompt text', async () => {
    const lines: string[] = [];
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(JSON.stringify([{ severity: 'medium', title: 'x', detail: 'y' }])),
      targets: [TARGET],
      ticketId: 1,
      debug: (m) => lines.push(m),
    });
    expect(outcome.kind).toBe('ran');
    // Entry: how many targets the lane is about to ask.
    expect(lines.some((l) => l.includes('review findings ticket 1') && l.includes('1 target(s)'))).toBe(
      true,
    );
    // Per-target: which repository was asked and what it came back with.
    expect(lines.some((l) => l.includes('asking target /web'))).toBe(true);
    expect(lines.some((l) => l.includes('/web returned 1 finding(s)'))).toBe(true);
    // Exit: the outcome.
    expect(lines.some((l) => l.includes('ran with 1 finding(s)'))).toBe(true);
    // Debug lines never carry the prompt (ticket prose) — only counts.
    for (const line of lines) {
      expect(line).not.toContain('Review the uncommitted and committed changes');
    }
  });

  it('debug lines name a rejected call and a stop when they happen', async () => {
    const lines: string[] = [];
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(() => Promise.reject(new Error('boom'))),
      targets: [TARGET],
      ticketId: 1,
      debug: (m) => lines.push(m),
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['boom'] });
    expect(lines.some((l) => l.includes('/web call failed') && l.includes('boom'))).toBe(true);

    const stopped: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await runFindingsLane({
      config: CONFIG,
      adapter: adapter('[]'),
      targets: [TARGET],
      ticketId: 1,
      signal: controller.signal,
      debug: (m) => stopped.push(m),
    });
    expect(stopped.some((l) => l.includes('stopped'))).toBe(true);
  });

  it('debug lines name the not-run and capability-missing decisions', async () => {
    const disabled: string[] = [];
    await runFindingsLane({
      config: DISABLED,
      adapter: adapter('[]'),
      targets: [TARGET],
      ticketId: 1,
      debug: (m) => disabled.push(m),
    });
    expect(disabled.some((l) => l.includes('disabled — not run'))).toBe(true);

    const missing: string[] = [];
    await runFindingsLane({
      config: CONFIG,
      targets: [TARGET],
      ticketId: 1,
      debug: (m) => missing.push(m),
    });
    expect(missing.some((l) => l.includes('capability-missing'))).toBe(true);
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

  // A deep review verifies suspicions against the repo (test runs, typecheck),
  // so the lane's own deadline is the generous gate-lane bound, never the
  // 15-minute quick-call backstop that kills a working review mid-lane.
  it('defaults the headless deadline to the gate-lane bound, so a deep diff review is not cut off', async () => {
    let seenTimeout: number | undefined;
    const runHeadless = vi.fn(async (headlessOpts: { timeoutMs?: number }) => {
      seenTimeout = headlessOpts.timeoutMs;
      return { sessionId: '', verdict: null, raw: '[]' };
    });
    await runFindingsLane({
      config: CONFIG,
      adapter: { ...adapter('[]'), runHeadless },
      targets: [TARGET],
      ticketId: 1,
    });
    expect(seenTimeout).toBe(GATE_LANE_HEADLESS_TIMEOUT_MS);
  });

  it('honors an explicit headless deadline from the caller', async () => {
    let seenTimeout: number | undefined;
    const runHeadless = vi.fn(async (headlessOpts: { timeoutMs?: number }) => {
      seenTimeout = headlessOpts.timeoutMs;
      return { sessionId: '', verdict: null, raw: '[]' };
    });
    await runFindingsLane({
      config: CONFIG,
      adapter: { ...adapter('[]'), runHeadless },
      targets: [TARGET],
      ticketId: 1,
      timeoutMs: 77_000,
    });
    expect(seenTimeout).toBe(77_000);
  });

  it('runs the Review process with its configured assignment model', async () => {
    const store = openStore(':memory:');
    try {
      const ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      let actualModel: string | undefined;
      await runFindingsLane({
        config: CONFIG,
        targets: [TARGET],
        ticketId,
        store,
        process: {
          assignment: {
            agentName: 'Review Agent',
            provider: 'claude',
            model: 'claude-opus-4-8',
          },
          adapter: {
            ...adapter('[]'),
            runHeadless: async (opts) => {
              actualModel = opts.model;
              return { sessionId: '', verdict: null, raw: '[]' };
            },
          },
        },
      });
      expect(actualModel).toBe('claude-opus-4-8');
      expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
        provider: 'claude',
        model: 'claude-opus-4-8',
      });
    } finally {
      store.close();
    }
  });

  it('a failed call contributes no findings for that target but does not throw', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(() => Promise.reject(new Error('boom'))),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['boom'] });
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['boom'] });
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
    expect(outcome.kind).toBe('ran');
    // The raw failure text was collapsed-then-capped before it was folded into
    // the warn line (and the crash record), so both stay well short of the
    // input size.
    if (outcome.kind !== 'ran') throw new Error('unreachable');
    expect(outcome.crashes?.[0]).not.toContain('\n');
    expect(outcome.crashes?.[0]!.length).toBeLessThan(huge.length);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).not.toContain('\n');
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

  // Finding 3: an aborted signal is an explicit stopped outcome, never a
  // silently truncated `ran` — checked before the first target and after
  // every awaited call.
  it('stops explicitly when the signal is already aborted, without asking any target', async () => {
    const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    const controller = new AbortController();
    controller.abort();
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: { ...adapter('[]'), runHeadless },
      targets: [TARGET, { repo: '/api', worktreePath: '/wt/api' }],
      ticketId: 1,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ kind: 'stopped', reason: 'Review stopped' });
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it('stops explicitly when the signal aborts between targets — the next target is never asked', async () => {
    const controller = new AbortController();
    const runHeadless = vi.fn(async () => {
      controller.abort();
      return { sessionId: '', verdict: null, raw: '[]' };
    });
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: { ...adapter('[]'), runHeadless },
      targets: [TARGET, { repo: '/api', worktreePath: '/wt/api' }],
      ticketId: 1,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ kind: 'stopped', reason: 'Review stopped' });
    expect(runHeadless).toHaveBeenCalledTimes(1);
  });

  // Residual-fix regression: an adapter that REJECTS on abort must read as the
  // Stop it is — the signal being aborted is the cancellation itself, never a
  // crash. Before the fix, the catch recorded the AbortError as an ordinary
  // crash and returned `ran`, so a cancellation during a real call looked like
  // a review that had run.
  it('returns stopped, not ran, when the adapter rejects on abort', async () => {
    const controller = new AbortController();
    const runHeadless = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = runFindingsLane({
      config: CONFIG,
      adapter: { ...adapter('[]'), runHeadless },
      targets: [TARGET],
      ticketId: 1,
      signal: controller.signal,
    });
    // The call is in flight and hangs until the signal aborts; by the next
    // macrotask the listener above is registered, so aborting now rejects it
    // while the lane is still waiting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'stopped', reason: 'Review stopped' });
    expect(runHeadless).toHaveBeenCalledTimes(1);
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
    expect(seenTracking).toEqual({ callSite: 'review-findings', ticketId: 42, processRunId: null });
  });

  it('attributes a failed call as a crash, distinct from a clean zero-findings run', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(() => Promise.reject(new Error('spawn ENOENT'))),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['spawn ENOENT'] });
  });
});

/**
 * The Review findings process run (Task 8): opened BEFORE the first AI call
 * with the resolved assignment snapshot, threaded through tracking so spend
 * and findings land on the process, and finished by the stage with an explicit
 * result kind. No call → no run: the lane opens one only when it actually
 * runs.
 */
describe('runFindingsLane — process run (Task 8)', () => {
  it('opens the Review process run before the first call and snapshots the assignment', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    try {
      const { outcome } = await planAndRunFindingsLane({
        entries: [entry(0)],
        targets: [TARGET],
        findingsConfig: CONFIG,
        store,
        process: {
          assignment: { agentName: 'Review Agent', provider: 'claude', model: 'claude-sonnet-5' },
          adapter: adapter('[]'),
          stageRunId: null,
          attempt: 0,
          startedAt: '2026-08-08T10:00:00.000Z',
        },
        ticketId,
      });
      expect(outcome.kind).toBe('ran');
      if (outcome.kind !== 'ran') throw new Error('unreachable');
      expect(outcome.processRunId).not.toBeUndefined();
      expect(outcome.processRunId).not.toBeNull();
      const run = listProcessRuns(store, ticketId)[0]!;
      expect(run).toMatchObject({
        id: outcome.processRunId,
        stageKey: 'review',
        processId: 'review',
        agentName: 'Review Agent',
        provider: 'claude',
        model: 'claude-sonnet-5',
      });
    } finally {
      store.close();
    }
  });

  it('threads the process run id into the adapter call, so spend lands on the process', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    let seenTracking: unknown;
    const a: AgentAdapter = {
      ...adapter('[]'),
      runHeadless: async (opts) => {
        seenTracking = opts.tracking;
        return { sessionId: '', verdict: null, raw: '[]' };
      },
    };
    try {
      await runFindingsLane({
        config: CONFIG,
        store,
        process: { assignment: { provider: 'claude' }, adapter: a, attempt: 0 },
        targets: [TARGET],
        ticketId,
      });
      const run = listProcessRuns(store, ticketId)[0]!;
      expect(seenTracking).toEqual({
        callSite: 'review-findings',
        ticketId,
        processRunId: run.id,
      });
    } finally {
      store.close();
    }
  });

  it('opens no run when the lane is skipped (gates already decided)', async () => {
    const store = openStore(':memory:');
    const ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    const runHeadless = vi.fn();
    try {
      const { outcome } = await planAndRunFindingsLane({
        entries: [entry(1)],
        targets: [TARGET],
        findingsConfig: CONFIG,
        store,
        process: { assignment: { provider: 'claude' }, adapter: { ...adapter('[]'), runHeadless }, attempt: 0 },
        ticketId,
      });
      expect(outcome).toEqual({ kind: 'not-run' });
      expect(runHeadless).not.toHaveBeenCalled();
      expect(listProcessRuns(store, ticketId)).toEqual([]);
    } finally {
      store.close();
    }
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['boom'] });
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
