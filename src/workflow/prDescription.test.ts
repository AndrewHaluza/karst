import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderPrDescription, buildPrDescriptionPrompt, gateSetChangedSincePreviousRun } from './prDescription.js';
import { openStore, type Store } from '../store/db.js';
import { openStageRun } from '../store/stageRuns.js';
import { createTicket } from '../store/tickets.js';

describe('renderPrDescription', () => {
  it('renders a useful body without invoking an agent', () => {
    expect(renderPrDescription({
      title: 'KAR-1 fix ship',
      commits: 'abc1234 fix the ship context\ndef5678 add coverage',
      diffStat: ' src/workflow/ship.ts | 8 +++++---\n 1 file changed',
    })).toBe([
      '## Summary',
      '',
      'KAR-1 fix ship',
      '',
      '## Changes',
      '',
      '- fix the ship context',
      '- add coverage',
      '',
      '## Changed files',
      '',
      '```text',
      ' src/workflow/ship.ts | 8 +++++---',
      ' 1 file changed',
      '```',
    ].join('\n'));
  });

  it('labels truncated sections honestly', () => {
    const body = renderPrDescription({
      title: 'KAR-1',
      commits: 'abc1234 fix',
      commitsTruncated: true,
      diffStat: 'a.ts | 1 +',
      diffStatTruncated: true,
    });
    expect(body).toContain('## Changes (truncated)');
    expect(body).toContain('## Changed files (truncated)');
  });

  it('falls back to the final PR title when git metadata is unavailable', () => {
    expect(renderPrDescription({ title: '[KAR-1] fix ship' })).toBe('[KAR-1] fix ship');
  });

  it('states a changed gate set in the body — a deleted gate must not read as a fixed one', () => {
    const body = renderPrDescription({
      title: 'KAR-1 fix ship',
      commits: 'abc1234 fix',
      gateSetChanged: true,
    });
    expect(body).toContain('## Note');
    expect(body).toContain('The gate set changed since the previous attempt of a gate stage');
    expect(body).toContain('a gate may have been removed rather than fixed');
  });

  it('renders nothing extra when the gate set did not change', () => {
    const body = renderPrDescription({ title: 'KAR-1', gateSetChanged: false });
    expect(body).toBe('KAR-1');
  });
});

describe('buildPrDescriptionPrompt', () => {
  it('instructs the AI body to state a changed gate set when one happened', () => {
    expect(buildPrDescriptionPrompt('KAR-1', true)).toContain(
      'The gate set for this ticket changed since the previous attempt of a gate stage',
    );
  });

  it('stays silent about the gate set when nothing changed', () => {
    expect(buildPrDescriptionPrompt('KAR-1', false)).not.toContain('gate set');
  });
});

describe('gateSetChangedSincePreviousRun', () => {
  let store: Store;
  let id: number;

  const run = (stageKey: 'uat' | 'review', attempt: number, runAt: string, manifestHash: string): void => {
    openStageRun(store, {
      ticketId: id,
      stageKey,
      attempt,
      runAt,
      startedAt: runAt,
      manifestHash,
      pid: null,
    });
  };

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'K-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  it('reports a changed hash between consecutive runs of a gate stage', () => {
    run('review', 0, '2026-08-01T10:00:00.000Z', 'hash-a');
    run('review', 1, '2026-08-01T11:00:00.000Z', 'hash-b');
    expect(gateSetChangedSincePreviousRun(store, id)).toBe(true);
  });

  it('is false when consecutive runs agree', () => {
    run('review', 0, '2026-08-01T10:00:00.000Z', 'hash-a');
    run('review', 1, '2026-08-01T11:00:00.000Z', 'hash-a');
    expect(gateSetChangedSincePreviousRun(store, id)).toBe(false);
  });

  it('ignores a single run — nothing to differ from', () => {
    run('uat', 0, '2026-08-01T10:00:00.000Z', 'hash-a');
    expect(gateSetChangedSincePreviousRun(store, id)).toBe(false);
  });

  it('checks every gate stage, not just the latest one', () => {
    run('uat', 0, '2026-08-01T10:00:00.000Z', 'hash-a');
    run('uat', 1, '2026-08-01T11:00:00.000Z', 'hash-b');
    run('review', 0, '2026-08-01T12:00:00.000Z', 'hash-c');
    expect(gateSetChangedSincePreviousRun(store, id)).toBe(true);
  });
});
