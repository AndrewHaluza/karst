import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket, setStageCurrent, updateTicketFields } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { recordFindings } from '../../store/reviewFindings.js';
import { claimStallSuggestion, failStallSuggestion, saveStallDiff, saveStallSuggestion } from '../../store/stallSuggestions.js';
import { buildStallView } from './stateStall.js';

const AT = '2026-01-01T00:00:10.000Z';
const OPT = { kind: 'agent' as const, label: 'Split', note: 'Split it.', recommended: true };

function setup(stalled = true) {
  const store = openStore(':memory:');
  const id = createTicket(store, { key: 'S', title: 's' }).id;
  updateTicketFields(store, id, { description: 'Desc', intent: 'Check' });
  recordFindings(store, { ticketId: id, attempt: 0, runAt: '2026-01-01T00:00:01Z', findings: [
    { severity: 'medium', repo: '/r', file: 'b.ts', title: 'm', detail: 'd', source: 'agent' },
    { severity: 'critical', repo: '/r', file: 'a.ts', title: 'c', detail: 'd', source: 'agent' },
  ] });
  if (stalled) {
    setStageCurrent(store, id, 'fix');
    setStage(store, id, 'fix', { blockedKind: 'review-stalled', blockedReason: 'r', blockedAt: AT });
  }
  return { store, id };
}
const view = (store: ReturnType<typeof openStore>, id: number) => buildStallView(store, id, 'medium');

describe('buildStallView', () => {
  it('is null when the ticket is not stalled', () => {
    const { store, id } = setup(false);
    expect(view(store, id)).toBeNull();
  });
  it('is null when the park has no row yet', () => {
    const { store, id } = setup();
    expect(view(store, id)).toBeNull();
  });
  it('shows generating with the evidence, worst finding first', () => {
    const { store, id } = setup();
    claimStallSuggestion(store, id, AT, AT);
    saveStallDiff(store, id, AT, { files: ['src/a.ts'], stat: ' a | 1 +' });
    const v = view(store, id)!;
    expect(v.status).toBe('generating');
    expect(v.rounds[0]!.findings.map((f) => f.severity)).toEqual(['critical', 'medium']);
    expect(v.diff).toEqual({ fileCount: 1, stat: ' a | 1 +' });
    expect(v.current).toEqual({ description: 'Desc', acceptanceCheck: 'Check' });
    expect(v.options).toEqual([]);
  });
  it('carries the options when ready, without the accept option on a code diff', () => {
    const { store, id } = setup();
    claimStallSuggestion(store, id, AT, AT);
    saveStallDiff(store, id, AT, { files: ['src/a.ts'], stat: '' });
    saveStallSuggestion(store, id, AT, { cause: 'Likely.', options: [OPT] }, AT);
    const v = view(store, id)!;
    expect(v).toMatchObject({ status: 'ready', cause: 'Likely.' });
    expect(v.options.map((o) => o.kind)).toEqual(['agent']);
  });
  it('adds the accept option from the host only on a docs-only diff', () => {
    const { store, id } = setup();
    claimStallSuggestion(store, id, AT, AT);
    saveStallDiff(store, id, AT, { files: ['docs/a.md'], stat: '' });
    saveStallSuggestion(store, id, AT, { cause: 'Likely.', options: [OPT] }, AT);
    const v = view(store, id)!;
    expect(v.options.map((o) => o.kind)).toEqual(['agent', 'accept-docs']);
    expect(v.options[1]!.recommended).toBe(false);
    expect(v.options[1]!.note).toContain('2 blocking findings');
  });
  it('offers the accept option on the recorded shape of T995: one docs file, 12 review runs, no ticket type', () => {
    const { store, id } = setup();
    for (let n = 1; n < 12; n += 1) {
      recordFindings(store, { ticketId: id, attempt: n, runAt: `2026-01-01T00:${String(n).padStart(2, '0')}:30Z`, findings: [
        { severity: 'high', repo: '/r', file: 'docs/research/report.md', title: `claim ${n}`, detail: 'd', source: 'agent' },
      ] });
    }
    claimStallSuggestion(store, id, AT, AT);
    saveStallDiff(store, id, AT, { files: ['docs/research/report.md'], stat: ' docs/research/report.md | 90 +' });
    saveStallSuggestion(store, id, AT, { cause: 'Likely an open-ended report.', options: [OPT] }, AT);
    const v = view(store, id)!;
    expect(v.rounds).toHaveLength(12);
    expect(v.options.map((o) => o.kind)).toEqual(['agent', 'accept-docs']);
    expect(v.options[1]!.label).toBe('Accept the report as it is');
  });
  it('carries the failure and the usage limit flag', () => {
    const { store, id } = setup();
    claimStallSuggestion(store, id, AT, AT);
    failStallSuggestion(store, id, AT, 'usage limit reached', true, AT);
    expect(view(store, id)).toMatchObject({ status: 'failed', error: 'usage limit reached', usageLimit: true, options: [] });
  });
});
