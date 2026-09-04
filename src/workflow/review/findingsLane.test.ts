import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicketFlow } from '../stages/create.js';
import { listProcessRuns } from '../../store/processRuns.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { RunHeadlessOpts } from '../../agent/adapter.js';
import type { AggregateEntry } from './aggregate.js';
import { buildFindingsPrompt, planAndRunFindingsLane, runFindingsLane } from './findingsLane.js';
import { GATE_LANE_HEADLESS_TIMEOUT_MS } from '../../agent/headlessSpawn.js';
import type { GitRunner } from '../../integrations/git.js';

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

/** An adapter that captures the opts of the ONE call it answers, for forward-assertions. */
function capturingAdapter(
  raw: string,
): { adapter: AgentAdapter; calls: RunHeadlessOpts[] } {
  const calls: RunHeadlessOpts[] = [];
  return {
    calls,
    adapter: {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used');
      },
      runHeadless: async (opts) => {
        calls.push(opts);
        return { sessionId: '', verdict: null, raw };
      },
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['boom'], targetCount: 1 });
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
      targetCount: 1,
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['boom'], targetCount: 1 });
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['boom'], targetCount: 1 });
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], unreadable: ['/web'], targetCount: 1 });
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], unreadable: ['/web'], targetCount: 1 });
  });

  // Phase 1 regression, exercised at the lane level: a core that narrates its
  // work before printing the array it was asked for must still yield the
  // findings buried in its prose — the exact failure mode from the reported
  // incident (a `high` finding read as zero because the parser only looked at
  // the whole document).
  it('yields the findings buried in narrated prose around a valid JSON array', async () => {
    const raw = [
      "Sure, let me look at the diff for this repository.",
      '',
      'Here is what I found:',
      JSON.stringify([{ severity: 'high', title: 'SQL injection', detail: 'unescaped input' }]),
      '',
      'Let me know if you want more detail.',
    ].join('\n');
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(raw),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({
      kind: 'ran',
      findings: [
        {
          severity: 'high',
          repo: '/web',
          file: null,
          line: null,
          title: 'SQL injection',
          detail: 'unescaped input',
          source: 'agent',
        },
      ],
      targetCount: 1,
    });
  });

  it('contributes its repo name to unreadable when a target returns pure prose', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter('The code looks fine to me, nothing to report here.'),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [], unreadable: ['/web'], targetCount: 1 });
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

  it('forwards onOutput verbatim into each headless call', async () => {
    const { adapter: a, calls } = capturingAdapter('[]');
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    await runFindingsLane({
      config: CONFIG,
      adapter: a,
      targets: [TARGET],
      ticketId: 1,
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(calls[0]!.onOutput).toBeDefined();
    calls[0]!.onOutput?.({ stream: 'stderr', text: 'progress' });
    expect(chunks).toEqual([{ stream: 'stderr', text: 'progress' }]);
  });

  it('emits per-target active/completed progress with a detail naming what came back', async () => {
    const events: { repo: string; status: string; detail?: string }[] = [];
    const perTarget: AgentAdapter = {
      ...adapter('[]'),
      runHeadless: async (opts) => ({
        sessionId: '',
        verdict: null,
        raw:
          opts.cwd === '/wt/web'
            ? JSON.stringify([{ severity: 'low', title: 'nit', detail: '', file: 'a.ts' }])
            : '[]',
      }),
    };
    await runFindingsLane({
      config: CONFIG,
      adapter: perTarget,
      targets: [
        { repo: '/web', worktreePath: '/wt/web' },
        { repo: '/api', worktreePath: '/wt/api' },
      ],
      ticketId: 1,
      onTargetProgress: (event) => events.push(event),
    });
    expect(events).toEqual([
      { repo: '/web', status: 'active' },
      { repo: '/web', status: 'completed', detail: '1 finding' },
      { repo: '/api', status: 'active' },
      { repo: '/api', status: 'completed', detail: '0 findings' },
    ]);
  });

  it('attributes a failed call as a crash, distinct from a clean zero-findings run', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(() => Promise.reject(new Error('spawn ENOENT'))),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['spawn ENOENT'], targetCount: 1 });
  });

  it('threads the process assignment instructions into the prompt and still parses the output', async () => {
    const runHeadless = vi.fn().mockResolvedValue({
      sessionId: '',
      verdict: null,
      raw: JSON.stringify([{ severity: 'high', title: 'leak', detail: 'x', file: 'src/a.ts' }]),
    });
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter('[]'),
      targets: [TARGET],
      ticketId: 1,
      process: {
        assignment: {
          agentName: 'Review Agent',
          provider: 'claude',
          instructions: 'Check error handling.',
        },
        adapter: { ...adapter('[]'), runHeadless },
      },
    });
    expect(outcome.kind).toBe('ran');
    expect(outcome).toEqual({
      kind: 'ran',
      findings: [expect.objectContaining({ severity: 'high', title: 'leak' })],
      targetCount: 1,
    });
    expect(runHeadless.mock.calls[0]![0].prompt).toContain('Check error handling.');
    expect(runHeadless.mock.calls[0]![0].prompt).toContain('Output rules (strict):');
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], targetCount: 1 });
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
    expect(outcome).toEqual({ kind: 'ran', findings: [], crashes: ['boom'], targetCount: 1 });
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

  // fu1: "review agent xterm log shows no changes, but diffs are present". The
  // branch is known to the host (`worktrees.branch`) and the scope block uses
  // `origin/<branch>` so a stale local ref never produces an empty diff.
  it('names the ticket branch in the scope block when one is known', () => {
    const prompt = buildFindingsPrompt('/web', 'develop', 'karst/feat/x');
    expect(prompt).toContain('git diff origin/develop...origin/karst/feat/x');
    expect(prompt).not.toContain('...HEAD');
    expect(prompt).toContain('This ticket\'s branch is `karst/feat/x`');
  });

  it('replaces the review lines with user instructions, keeping the target context and output rules', () => {
    const prompt = buildFindingsPrompt(
      '/web',
      'develop',
      'karst/feat/x',
      'Focus on error handling and regression patterns.',
    );
    expect(prompt).toContain('Focus on error handling and regression patterns.');
    // The facts the agent needs survive — repo and base branch.
    expect(prompt).toContain('Repository: /web');
    expect(prompt).toContain('develop');
    // The default review strategy lines are replaced...
    expect(prompt).not.toContain('Review the uncommitted and committed changes');
    expect(prompt).not.toContain('DIFF ONLY');
    // ...but the structured-output contract is non-negotiable.
    expect(prompt).toContain('Output rules (strict):');
    expect(prompt).toContain('JSON array');
  });

  it('carries the scope block, with the exact diff range, in both prompt shapes', () => {
    for (const prompt of [
      buildFindingsPrompt('/web', 'develop'),
      buildFindingsPrompt('/web', 'develop', 'karst/feat/x', 'Focus on error handling.'),
    ]) {
      expect(prompt).toContain('Do NOT run repository-wide reconnaissance');
      expect(prompt).toContain('orchestration tool that launched you');
    }
    // The branch-named shape must keep the branch-named range.
    expect(buildFindingsPrompt('/web', 'develop', 'karst/feat/x', 'Focus on error handling.')).toContain(
      'git diff origin/develop...origin/karst/feat/x',
    );
  });

  it('treats blank instructions as absent', () => {
    // openChanges defaults to OFF → committed changes only.
    const prompt = buildFindingsPrompt('/web', 'develop', 'karst/feat/x', '  ');
    expect(prompt).toContain('Review the committed changes');
  });

  it('keeps today\'s uncommitted prose when openChanges is on and git is absent', async () => {
    const { adapter: headless, calls } = capturingAdapter('[]');
    await runFindingsLane({
      config: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
      adapter: headless,
      targets: [{ repo: '/web', worktreePath: '/wt/web', baseRef: 'develop', branch: 'karst/x' }],
      ticketId: 1,
      openChanges: true,
    });
    expect(calls[0]!.prompt).toContain('uncommitted and committed changes');
    expect(calls[0]!.prompt).not.toContain('refs/karst/snapshot/');
  });
});


/**
 * The wrong-checkout guard. A weak reviewer model reported this against a
 * worktree provably on the ticket's branch, blocking a ticket over a diff it
 * had actually read — and because the finding was PERSISTED, every later fix
 * attempt was handed the same stale critical.
 */
describe('runFindingsLane — disproven wrong-checkout claims', () => {
  const CLAIM = JSON.stringify([
    {
      severity: 'critical',
      title: 'wrong checkout',
      detail: 'Expected branch karst/x but HEAD is on develop.',
    },
  ]);
  const target = { repo: '/web', worktreePath: '/wt/web', baseRef: 'develop', branch: 'karst/x' };
  const gitOn = (branch: string): GitRunner =>
    vi.fn(async () => ({ stdout: `${branch}\n`, stderr: '', exitCode: 0 })) as unknown as GitRunner;

  it('drops the claim, and never persists it, when HEAD really is the branch', async () => {
    const persistFindings = vi.fn();
    const warn = vi.fn();
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(CLAIM),
      targets: [target],
      ticketId: 1,
      git: gitOn('karst/x'),
      persistFindings,
      warn,
    });

    expect(outcome.kind).toBe('ran');
    expect(outcome.kind === 'ran' && outcome.findings).toEqual([]);
    // Persisted findings outlive the run: dropping it after the write would
    // leave the fix stage receiving it forever.
    expect(persistFindings).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wrong checkout'));
  });

  it('KEEPS the claim when the checkout really is wrong', async () => {
    const persistFindings = vi.fn();
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(CLAIM),
      targets: [target],
      ticketId: 1,
      git: gitOn('develop'),
      persistFindings,
    });

    expect(outcome.kind === 'ran' && outcome.findings).toHaveLength(1);
    expect(persistFindings).toHaveBeenCalled();
  });

  it('KEEPS the claim when no git runner can settle it', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(CLAIM),
      targets: [target],
      ticketId: 1,
    });
    expect(outcome.kind === 'ran' && outcome.findings).toHaveLength(1);
  });

  it('does not probe git when no such claim was made', async () => {
    const git = gitOn('karst/x');
    await runFindingsLane({
      config: CONFIG,
      adapter: adapter('[]'),
      targets: [target],
      ticketId: 1,
      git,
    });
    // The normal path pays no git call.
    expect(git).not.toHaveBeenCalled();
  });

  it('leaves every other finding of the same call untouched', async () => {
    const mixed = JSON.stringify([
      { severity: 'critical', title: 'wrong checkout', detail: 'HEAD is on develop.' },
      { severity: 'high', title: 'unbounded loop', detail: 'spins forever on an empty list.' },
    ]);
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(mixed),
      targets: [target],
      ticketId: 1,
      git: gitOn('karst/x'),
    });
    const kept = outcome.kind === 'ran' ? outcome.findings : [];
    expect(kept.map((f) => f.title)).toEqual(['unbounded loop']);
  });
});
