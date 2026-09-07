import { describe, it, expect } from 'vitest';
import { openStore } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import { openImplementationRun } from './implementationRuns.js';
import { openProcessRun, finishProcessRun, setProcessRunPromptTelemetry } from './processRuns.js';
import { openStageRun, closeStageRun } from './stageRuns.js';
import { recordGuidePull } from '../cli/guideTelemetry.js';
import { queryPromptMetrics } from './promptTelemetryQuery.js';

describe('queryPromptMetrics', () => {
  it('computes the per-core guide-pull rate from seeded sessions vs pull rows', () => {
    const store = openStore(':memory:');
    try {
      const t = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, t, 'scope', { kind: 'passed' });
      // one seeded session run (guide pointer present), core claude
      const run = openImplementationRun(store, {
        ticketId: t,
        attempt: 0,
        provider: 'claude',
        startedAt: '2026-09-07T00:00:00.000Z',
        promptTelemetry: { seedChars: 1000, guidePointer: true, core: 'claude' },
      });
      expect(run.processRunId).toBeGreaterThan(0);
      // one attributed guide pull, same core
      recordGuidePull(store, { dbPath: 'x', ticketId: t, launchId: 'L', provider: 'claude' }, () => '2026-09-07T00:01:00.000Z');
      const m = queryPromptMetrics(store, null);
      expect(m.guidePullByCore.claude).toEqual({ pulls: 1, sessionsSeeded: 1, rate: 1 });
    } finally {
      store.close();
    }
  });

  it('summarizes the recorded seed size as a bounded distribution', () => {
    const store = openStore(':memory:');
    try {
      for (const [key, chars] of [['A', 100], ['B', 200], ['C', 300]] as const) {
        const t = createTicketFlow(store, { key, title: 't' }).id;
        transition(store, t, 'scope', { kind: 'passed' });
        openImplementationRun(store, {
          ticketId: t, attempt: 0, provider: 'claude',
          startedAt: '2026-09-07T00:00:00.000Z',
          promptTelemetry: { seedChars: chars, guidePointer: true, core: 'claude' },
        });
      }
      const s = queryPromptMetrics(store, null).seedSizeChars;
      expect(s).toMatchObject({ count: 3, avg: 200, min: 100, max: 300, p50: 200 });
    } finally {
      store.close();
    }
  });

  it('reads marker compliance from stage_runs outcomes', () => {
    const store = openStore(':memory:');
    try {
      const t = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, t, 'scope', { kind: 'passed' });
      const r1 = openStageRun(store, { ticketId: t, stageKey: 'impl', attempt: 0, runAt: '2026-09-07T00:00:00.000Z', startedAt: '2026-09-07T00:00:00.000Z' });
      closeStageRun(store, r1, 'advanced', '2026-09-07T00:01:00.000Z');
      const r2 = openStageRun(store, { ticketId: t, stageKey: 'impl', attempt: 0, runAt: '2026-09-07T01:00:00.000Z', startedAt: '2026-09-07T01:00:00.000Z' });
      closeStageRun(store, r2, 'stopped', '2026-09-07T01:01:00.000Z');
      const m = queryPromptMetrics(store, null).markerCompliance;
      expect(m).toMatchObject({ advanced: 1, stopped: 1, finished: 2 });
      expect(m.rate).toBeCloseTo(0.5, 5);
    } finally {
      store.close();
    }
  });

  it('folds the findings parse-tier histograms across review runs', () => {
    const store = openStore(':memory:');
    try {
      const t = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, t, 'scope', { kind: 'passed' });
      const run = openProcessRun(store, { ticketId: t, stageKey: 'review', processId: 'review', attempt: 0, provider: 'claude', startedAt: '2026-09-07T00:00:00.000Z' });
      setProcessRunPromptTelemetry(store, run.id, { parseTiers: JSON.stringify({ 'whole-doc': 2, fenced: 1 }) });
      const tiers = queryPromptMetrics(store, null).findingsParseTiers;
      expect(tiers).toMatchObject({ 'whole-doc': 2, fenced: 1 });
    } finally {
      store.close();
    }
  });

  it('counts tester silence-nudge fires', () => {
    const store = openStore(':memory:');
    try {
      const t = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, t, 'scope', { kind: 'passed' });
      transition(store, t, 'impl', { kind: 'passed' });
      const run = openProcessRun(store, { ticketId: t, stageKey: 'uat', processId: 'tester', attempt: 0, provider: 'claude', startedAt: '2026-09-07T00:00:00.000Z' });
      setProcessRunPromptTelemetry(store, run.id, { silenceNudges: 2 });
      finishProcessRun(store, run.id, 'passed', '2026-09-07T00:01:00.000Z', 'observed');
      const m = queryPromptMetrics(store, null).testerReAsk;
      expect(m).toMatchObject({ runs: 1, totalNudges: 2 });
    } finally {
      store.close();
    }
  });

  it('returns empty/zero metrics for a store with no runs (never invents a baseline)', () => {
    const store = openStore(':memory:');
    try {
      const m = queryPromptMetrics(store, null);
      expect(m.guidePullByCore).toEqual({});
      expect(m.seedSizeChars).toMatchObject({ count: 0, avg: null, max: null });
      expect(m.markerCompliance.rate).toBeNull();
    } finally {
      store.close();
    }
  });
});
