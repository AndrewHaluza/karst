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

  it('a failed call contributes no findings for that target but does not throw', async () => {
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter(() => Promise.reject(new Error('boom'))),
      targets: [TARGET],
      ticketId: 1,
    });
    expect(outcome).toEqual({ kind: 'ran', findings: [] });
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
});

describe('buildFindingsPrompt', () => {
  it('names the target repository and asks for JSON only', () => {
    const prompt = buildFindingsPrompt('/web');
    expect(prompt).toContain('/web');
    expect(prompt).toContain('JSON array');
  });
});
