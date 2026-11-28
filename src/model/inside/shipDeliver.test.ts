import { describe, expect, it } from 'vitest';
import type { DeliverFacts } from './deliver.js';
import { DELIVER_PUSH_TITLE, deliverPushRows, deliverPushSummary, type DeliverRowInput } from './shipDeliver.js';
import type { EvidenceRow } from './types.js';

const NOW = '2026-10-27T22:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const facts = (over: Partial<DeliverFacts> = {}): DeliverFacts => ({
  running: null,
  failures: [],
  takenOver: null,
  roundActive: false,
  headSha: A,
  ...over,
});

const input = (over: Partial<DeliverRowInput> = {}): DeliverRowInput => ({
  notOnPr: 2,
  inSandbox: 0,
  canDeliver: true,
  auto: null,
  ...over,
});

const gate = (
  name: string,
  status: 'pass' | 'fail' | 'run' | 'wait' | 'pending',
  over: Partial<NonNullable<DeliverFacts['gates']>[number]> = {},
) => ({ name, repo: '/wt/api', status, startedAt: null, endedAt: null, exitCode: null, ...over });

const autoWithGates = (over: Partial<DeliverFacts> = {}): DeliverFacts =>
  facts({
    running: { n: 2, m: 3, gate: 'docs' },
    gates: [
      gate('unit', 'pass', { startedAt: '2026-10-27T21:40:00.000Z', endedAt: '2026-10-27T21:42:00.000Z', exitCode: 0 }),
      gate('docs', 'run'),
      gate('visual', 'pending'),
    ],
    ...over,
  });

const labels = (rows: readonly EvidenceRow[]) => rows.map((r) => [r.label, r.status, r.detail, r.repo]);

describe('deliverPushRows — one row per pre-push gate (T1403)', () => {
  it('lists every planned gate with its status, time and duration', () => {
    const rows = deliverPushRows(input({ canDeliver: false, auto: autoWithGates() }), NOW, () => 'api');
    expect(labels(rows)).toEqual([
      ['unit', 'pass', 'passed', 'api'],
      ['docs', 'run', 'running…', 'api'],
      ['visual', 'pending', 'queued', 'api'],
    ]);
    expect(rows[0]).toMatchObject({ time: expect.any(String), duration: '2m 0s', durationExact: '120.000s' });
    // The running gate has no stamp of its own: it counts from the gate that ended before it.
    expect(rows[1]).toMatchObject({ time: expect.any(String), duration: '18m 0s', durationExact: '1080.000s' });
    expect(rows[2]).not.toHaveProperty('time');
    expect(rows[2]).not.toHaveProperty('duration');
  });

  it('marks every gate row with the deliver marker (never a per-repository push row)', () => {
    for (const r of deliverPushRows(input({ canDeliver: false, auto: autoWithGates() }), NOW)) expect(r.deliverGate).toBe(true);
  });

  it('words a failed gate as its exit code and keeps its run time', () => {
    const auto = facts({
      running: null,
      gates: [gate('docs', 'fail', { startedAt: '2026-10-27T21:40:00.000Z', endedAt: '2026-10-27T21:41:30.000Z', exitCode: 2 })],
    });
    const [row] = deliverPushRows(input({ canDeliver: false, auto }), NOW);
    expect(row).toMatchObject({ label: 'docs', status: 'fail', detail: 'exit 2', duration: '1m 30s' });
  });

  it('words a gate that waits for a slot with the gate-row wait copy and no timer', () => {
    const auto = facts({
      running: { n: 2, m: 3, gate: 'docs', waiting: true },
      gates: [gate('unit', 'pass', { startedAt: '2026-10-27T21:40:00.000Z', endedAt: '2026-10-27T21:42:00.000Z', exitCode: 0 }), gate('docs', 'wait'), gate('visual', 'pending')],
    });
    const rows = deliverPushRows(input({ canDeliver: false, auto }), NOW);
    expect(rows[1]).toEqual({ label: 'docs', detail: 'waiting for a free slot', status: 'wait', repo: '/wt/api', deliverGate: true });
  });

  it('heads a base check with one phase row before its gates', () => {
    const auto = facts({
      running: { n: 1, m: 2, gate: 'unit', baseCheck: true },
      gates: [gate('unit', 'run'), gate('visual', 'pending')],
    });
    const rows = deliverPushRows(input({ canDeliver: false, auto }), NOW);
    expect(rows[0]).toEqual({ label: 'Check before push', role: 'phase' });
    expect(rows.slice(1).map((r) => r.label)).toEqual(['unit', 'visual']);
  });

  it('keeps one running row worded as before when the record carries no gate facts', () => {
    const auto = facts({ running: { n: 2, m: 5, gate: 'docs' } });
    expect(labels(deliverPushRows(input({ canDeliver: false, auto }), NOW))).toEqual([['Gate 2 of 5', 'run', 'docs', undefined]]);
    const base = facts({ running: { n: 2, m: 5, gate: 'docs', baseCheck: true } });
    expect(labels(deliverPushRows(input({ canDeliver: false, auto: base }), NOW))).toEqual([['Check before push: gate 2 of 5', 'run', 'docs', undefined]]);
  });

  it('keeps a failure that the current run did not list as its own fail row, with its Dismiss', () => {
    const auto = autoWithGates({
      running: { n: 3, m: 3, gate: 'visual' },
      failures: [{ gate: 'docs', repo: '/wt/api', exitCode: 1, headSha: A, summary: 'boom' }],
      gates: [gate('unit', 'pass'), gate('docs', 'fail', { exitCode: 1, endedAt: NOW }), gate('visual', 'run')],
    });
    const kept = deliverPushRows(input({ canDeliver: false, auto }), NOW).filter((r) => r.label.startsWith('Gate '));
    // `docs` is the current run's own fail row: it is not repeated as a kept failure.
    expect(kept).toEqual([]);

    const older = facts({ failures: [{ gate: 'docs', repo: '/wt/api', exitCode: 2, headSha: B, summary: 'boom' }] });
    expect(deliverPushRows(input({ canDeliver: false, auto: older }), NOW)).toEqual([
      { label: 'Gate docs failed', detail: `exit 2 · on an older head ${'b'.repeat(9)}`, status: 'fail', deliverDismiss: { gate: 'docs' }, output: 'boom' },
    ]);
  });

  it('gives a failed gate of the current run its own Dismiss and output when the failure is on record (T1403)', () => {
    const auto = autoWithGates({
      running: null,
      failures: [{ gate: 'docs', repo: '/wt/api', exitCode: 1, headSha: A, summary: 'boom' }],
      gates: [gate('unit', 'pass'), gate('docs', 'fail', { exitCode: 1 })],
    });
    const rows = deliverPushRows(input({ canDeliver: false, auto }), NOW);
    expect(rows.find((r) => r.label === 'docs')).toMatchObject({ status: 'fail', detail: 'exit 1', deliverDismiss: { gate: 'docs' }, output: 'boom' });
    expect(rows.find((r) => r.label === 'unit')?.deliverDismiss).toBeUndefined();
    // A fail row with no failure on record (already dismissed) offers no Dismiss.
    const dismissed = autoWithGates({ running: null, failures: [], gates: [gate('docs', 'fail', { exitCode: 1 })] });
    expect(deliverPushRows(input({ canDeliver: false, auto: dismissed }), NOW)[0]?.deliverDismiss).toBeUndefined();
  });

  it('lists the pending sync and push rows while the host found commits to deliver', () => {
    const rows = deliverPushRows(input(), NOW);
    expect(rows).toEqual([
      { label: 'Sync the sandbox', status: 'pending' },
      { label: 'Push the branch', detail: 'after the sync', status: 'pending' },
    ]);
  });

  it('returns no rows for no deliver reading', () => {
    expect(deliverPushRows(null, NOW)).toEqual([]);
    expect(deliverPushRows(undefined, NOW)).toEqual([]);
  });
});

describe('deliverPushSummary (T1403)', () => {
  it('is null when nothing is undelivered and no run left a record', () => {
    expect(deliverPushSummary(null)).toBeNull();
    expect(deliverPushSummary(undefined)).toBeNull();
    expect(deliverPushSummary(input({ canDeliver: false, notOnPr: 0 }))).toBeNull();
  });

  it('states the commits not on the PR and carries the Push title', () => {
    const s = deliverPushSummary(input({ inSandbox: 1 }))!;
    expect(s).toMatchObject({ status: 'wait', detailParts: ['2 commits not on the PR (1 still in the sandbox)'] });
    expect(s.deliver!.title).toBe(DELIVER_PUSH_TITLE);
  });

  it('is run while a gate runs, with the gate as a detail part and the hint as the Push title', () => {
    const s = deliverPushSummary(input({ auto: facts({ running: { n: 4, m: 5, gate: 'docs' } }) }))!;
    expect(s.status).toBe('run');
    expect(s.detailParts).toEqual(['2 commits not on the PR', 'gate 4 of 5']);
    expect(s.deliver!.title).toBe('Push — auto-deliver runs gate 4/5 (docs). Deliver stops these gates and pushes; if the base moved since the merge, the gates run on the new merge first.');
    expect(s.console).toBe(true);
  });

  it('words a base check as checking before push', () => {
    const s = deliverPushSummary(input({ canDeliver: false, auto: facts({ running: { n: 2, m: 5, gate: 'visual', baseCheck: true } }) }))!;
    expect(s.status).toBe('run');
    expect(s.detailParts).toEqual(['checking before push: gate 2 of 5']);
    expect(s.deliver).toBeUndefined();
  });

  it('is fail while a kept failure exists, and note for a record with nothing left to push', () => {
    expect(deliverPushSummary(input({ canDeliver: false, auto: facts({ failures: [{ gate: 'unit', repo: 'r', exitCode: 2, headSha: A, summary: null }] }) }))!.status).toBe('fail');
    const takeover = deliverPushSummary(input({ canDeliver: false, notOnPr: 0, auto: facts({ takenOver: { failed: ['unit'], skipped: [] } }) }))!;
    expect(takeover.status).toBe('note');
    expect(takeover.detailParts).toEqual(['Delivery taken over by a manual Deliver; failed: unit; skipped: none']);
    expect(takeover.deliver).toBeUndefined();
  });
});
