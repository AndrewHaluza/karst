import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import { recordFindings, type FindingInput } from '../store/reviewFindings.js';
import { getStallSuggestion } from '../store/stallSuggestions.js';
import type { AgentAdapter } from '../agent/adapter.js';
import { UsageLimitError } from '../agent/cliFailure.js';
import { buildStallPrompt, generateStallSuggestion, isDocsOnlyDiff, openBlockingCount, stallRounds } from './stallSuggestion.js';

const f = (over: Partial<FindingInput> = {}): FindingInput => ({
  severity: 'high', repo: '/r', file: 'a.ts', title: 't', detail: 'd', source: 'agent', ...over,
});
const GOOD = JSON.stringify({ cause: 'Likely a design gap.', options: [{ label: 'Split', note: 'Split it.', recommended: true }] });

function setup(run: (call: { policy?: string; tracking?: unknown }) => Promise<{ raw: string }>) {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'S', title: 's' }).id;
  updateTicketFields(store, ticketId, { description: 'Desc', intent: 'Check' });
  recordFindings(store, { ticketId, attempt: 0, runAt: '2026-01-01T00:00:01Z', findings: [f({ severity: 'medium', file: 'b.ts' }), f({ severity: 'critical' }), f({ severity: 'low' })] });
  recordFindings(store, { ticketId, attempt: 1, runAt: '2026-01-01T00:00:02Z', findings: [f()] });
  const runHeadless = vi.fn((call: { policy?: string; tracking?: unknown }) => run(call));
  const adapter = { runHeadless } as unknown as AgentAdapter;
  const deps = { store, adapter, ticketId, cwd: '/w', blockingSeverity: 'medium' as const, diff: { files: ['a.ts'], stat: ' a.ts | 2 +-' } };
  return { store, ticketId, runHeadless, deps };
}

describe('stallRounds', () => {
  it('lists blocking rounds oldest first with the worst finding first', () => {
    const { store, ticketId } = setup(async () => ({ raw: GOOD }));
    const rounds = stallRounds(store, ticketId, 'medium');
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.findings.map((x) => x.severity)).toEqual(['critical', 'medium']);
    expect(openBlockingCount(rounds)).toBe(1);
    expect(stallRounds(store, ticketId, 'none')).toEqual([]);
  });
});

describe('isDocsOnlyDiff', () => {
  it.each([
    [['docs/a.md', 'docs/x/b.md'], true],
    [['docs/a.md', 'src/a.ts'], false],
    [[], false],
    [['docs/../src/a.ts'], false],
    [['notdocs/a.md'], false],
  ])('%j -> %s', (files, expected) => expect(isDocsOnlyDiff(files)).toBe(expected));
});

describe('buildStallPrompt', () => {
  it('carries the evidence and stays small', () => {
    const { store, ticketId } = setup(async () => ({ raw: GOOD }));
    const p = buildStallPrompt({ description: 'D', acceptanceCheck: 'C', diffStat: 'S', rounds: stallRounds(store, ticketId, 'medium') });
    expect(p).toContain('Round 2:');
    expect(p).toContain('[critical] a.ts');
    expect(p.length).toBeLessThan(2500);
  });
});

describe('generateStallSuggestion', () => {
  it('stores a ready suggestion, read-only, under its own call site', async () => {
    const { store, ticketId, runHeadless, deps } = setup(async () => ({ raw: GOOD }));
    expect(await generateStallSuggestion(deps, 'P1')).toBe('ready');
    const call = runHeadless.mock.calls[0]![0];
    expect(call.policy).toBe('reviewer');
    expect(call.tracking).toMatchObject({ callSite: 'stall-suggestion', ticketId });
    expect(getStallSuggestion(store, ticketId, 'P1')?.status).toBe('ready');
  });
  it('does not call twice for one park', async () => {
    const { runHeadless, deps } = setup(async () => ({ raw: GOOD }));
    await generateStallSuggestion(deps, 'P1');
    expect(await generateStallSuggestion(deps, 'P1')).toBe('skipped');
    expect(runHeadless).toHaveBeenCalledTimes(1);
  });
  it('counts an unreadable answer as failed, and Retry can recover', async () => {
    let answer = 'nonsense';
    const { store, ticketId, deps } = setup(async () => ({ raw: answer }));
    expect(await generateStallSuggestion(deps, 'P1')).toBe('failed');
    expect(getStallSuggestion(store, ticketId, 'P1')).toMatchObject({ status: 'failed', usageLimit: false });
    answer = GOOD;
    expect(await generateStallSuggestion(deps, 'P1', true)).toBe('ready');
  });
  it('records a usage limit as failed with the flag', async () => {
    const { store, ticketId, deps } = setup(async () => {
      throw new UsageLimitError('usage limit reached', { tool: 'claude' });
    });
    expect(await generateStallSuggestion(deps, 'P1')).toBe('failed');
    expect(getStallSuggestion(store, ticketId, 'P1')).toMatchObject({ status: 'failed', usageLimit: true });
  });
  it('records any other thrown error as failed', async () => {
    const { store, ticketId, deps } = setup(async () => {
      throw new Error('boom');
    });
    await generateStallSuggestion(deps, 'P1');
    const row = getStallSuggestion(store, ticketId, 'P1');
    expect(row).toMatchObject({ status: 'failed', usageLimit: false });
    expect(row?.status === 'failed' && row.error).toContain('boom');
  });
});
