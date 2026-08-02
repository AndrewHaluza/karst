import { describe, it, expect } from 'vitest';
import { buildStepper } from './stepper.js';
import { MAX_DIAGNOSTIC_CHARS } from './diagnosticText.js';

describe('buildStepper', () => {
  it('orders cells by STAGE_KEYS regardless of input order', () => {
    const cells = buildStepper([
      { stageKey: 'impl', status: 'running' },
      { stageKey: 'scope', status: 'passed' },
    ]);
    expect(cells.map((c) => c.stageKey)).toEqual([
      'scope', 'impl', 'uat', 'review', 'fix', 'ship', 'merge', 'done',
    ]);
    expect(cells[0]).toEqual({ stageKey: 'scope', status: 'passed' });
    expect(cells[1]).toEqual({ stageKey: 'impl', status: 'running' });
  });

  it('defaults a stage with no row to pending', () => {
    const cells = buildStepper([{ stageKey: 'scope', status: 'passed' }]);
    expect(cells.find((c) => c.stageKey === 'uat')!.status).toBe('pending');
  });

  it('returns all pending for an empty ticket', () => {
    const cells = buildStepper([]);
    expect(cells).toHaveLength(8);
    expect(cells.every((c) => c.status === 'pending')).toBe(true);
  });

  it('carries a failed stage its reason, log path, timestamps and attempt', () => {
    const cells = buildStepper([
      {
        stageKey: 'review',
        status: 'failed',
        verdict: 'gates failed: lint, test',
        artifactPath: '/logs/review-ticket-3.log',
        startedAt: '2026-07-16T10:00:00.000Z',
        endedAt: '2026-07-16T10:00:42.000Z',
        attempt: 2,
      },
    ]);
    expect(cells.find((c) => c.stageKey === 'review')).toEqual({
      stageKey: 'review',
      status: 'failed',
      reason: 'gates failed: lint, test',
      artifactPath: '/logs/review-ticket-3.log',
      startedAt: '2026-07-16T10:00:00.000Z',
      endedAt: '2026-07-16T10:00:42.000Z',
      attempt: 2,
    });
  });

  it('omits null detail fields rather than surfacing nulls to the view', () => {
    const cells = buildStepper([
      {
        stageKey: 'impl',
        status: 'running',
        verdict: null,
        artifactPath: null,
        startedAt: '2026-07-16T10:00:00.000Z',
        endedAt: null,
        attempt: 0,
      },
    ]);
    const impl = cells.find((c) => c.stageKey === 'impl')!;
    expect(impl.reason).toBeUndefined();
    expect(impl.artifactPath).toBeUndefined();
    expect(impl.endedAt).toBeUndefined();
    expect(impl.startedAt).toBe('2026-07-16T10:00:00.000Z');
    expect(impl.attempt).toBe(0);
  });

  it('a stage with no row carries no detail at all', () => {
    const cells = buildStepper([{ stageKey: 'scope', status: 'passed' }]);
    expect(cells.find((c) => c.stageKey === 'ship')).toEqual({
      stageKey: 'ship',
      status: 'pending',
    });
  });

  it('carries a blocked stage its kind, reason and when it happened', () => {
    const cells = buildStepper([
      {
        stageKey: 'review',
        status: 'running',
        blockedKind: 'nothing-to-run',
        blockedReason: 'no target resolved',
        blockedAt: '2026-07-16T10:00:00.000Z',
      },
    ]);
    expect(cells.find((c) => c.stageKey === 'review')!.blocked).toEqual({
      kind: 'nothing-to-run',
      reason: 'no target resolved',
      at: '2026-07-16T10:00:00.000Z',
    });
  });

  it('omits blocked entirely when the stage carries no blockedKind', () => {
    const cells = buildStepper([
      { stageKey: 'review', status: 'running', blockedKind: null, blockedReason: null, blockedAt: null },
    ]);
    expect(cells.find((c) => c.stageKey === 'review')!.blocked).toBeUndefined();
  });

  // The reviewer's Important finding (task 8, fix round 1): `verdict` and
  // `blockedReason` are untrusted CLI/git prose (e.g. raw `git status`
  // stderr, see workflow/gates/targets.ts) — unbounded and possibly
  // multi-line. Both reach the dashboard's fault card / blocked banner /
  // Inside op row verbatim unless collapsed here, at the one place both
  // fields are built.
  it('collapses a multi-line verdict to one line before it reaches the cell', () => {
    const cells = buildStepper([
      { stageKey: 'review', status: 'failed', verdict: 'line one\nline two\n\nline three' },
    ]);
    expect(cells.find((c) => c.stageKey === 'review')!.reason).toBe('line one line two line three');
  });

  it('caps an over-length verdict rather than shipping it whole to the view', () => {
    const huge = 'x'.repeat(MAX_DIAGNOSTIC_CHARS + 500);
    const cells = buildStepper([{ stageKey: 'review', status: 'failed', verdict: huge }]);
    const reason = cells.find((c) => c.stageKey === 'review')!.reason!;
    expect(reason.length).toBe(MAX_DIAGNOSTIC_CHARS + 1); // +1 for the ellipsis
    expect(reason.endsWith('…')).toBe(true);
  });

  it('collapses and caps a blocked reason the same way', () => {
    const huge = `git status failed:\n${'e'.repeat(MAX_DIAGNOSTIC_CHARS + 500)}`;
    const cells = buildStepper([
      {
        stageKey: 'review',
        status: 'running',
        blockedKind: 'capability-missing',
        blockedReason: huge,
        blockedAt: '2026-07-16T10:00:00.000Z',
      },
    ]);
    const reason = cells.find((c) => c.stageKey === 'review')!.blocked!.reason;
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + 1);
    expect(reason.endsWith('…')).toBe(true);
  });
});
