import { test, expect } from '@playwright/test';
import {
  ALL_VIEWS,
  MINIMAL_RATCHET,
  getCorpus,
  dashboardCorpora,
} from './corpora.js';
import type { ViewId } from './corpora.js';

test.describe('corpus adapter', () => {
  for (const viewId of ALL_VIEWS) {
    test(`${viewId}: has a corpus entry`, () => {
      const corpus = getCorpus(viewId);
      expect(corpus.messages.length).toBeGreaterThan(0);
    });
  }

  test('dashboard is NOT in the MINIMAL ratchet', () => {
    expect(MINIMAL_RATCHET).not.toContain('dashboard');
  });

  test('dashboard has 6 scenarios for the 10-repository row', () => {
    const corpora = dashboardCorpora();
    expect(corpora).toHaveLength(6);
    const scenarios = corpora.map((c) => c.scenario);
    expect(scenarios).toEqual([
      'pending',
      'running',
      'passed',
      'failed',
      'waiting',
      'exhausted',
    ]);
  });

  test('MINIMAL_RATCHET is a subset of ALL_VIEWS', () => {
    for (const v of MINIMAL_RATCHET) {
      expect(ALL_VIEWS).toContain(v);
    }
  });

  test('MINIMAL_RATCHET size never grows (shrink-only ratchet)', () => {
    // At plan time: 7 non-dashboard views on MINIMAL.
    // This assertion FORBIDS the ratchet from growing.  When FEAT-37
    // delivers a corpus for a view, it is removed from the ratchet and
    // this number decreases.  If someone adds a new webview, they must
    // either deliver a corpus or explicitly document why the ratchet
    // grew — and update this number with a justification.
    expect(MINIMAL_RATCHET.length).toBeLessThanOrEqual(7);
  });

  test('every MINIMAL_RATCHET view produces a non-empty message list', () => {
    for (const v of MINIMAL_RATCHET) {
      const corpus = getCorpus(v);
      expect(corpus.messages.length).toBeGreaterThan(0);
      // Every message must be a state message
      const msg = corpus.messages[0] as { type: string };
      expect(msg.type).toBe('state');
    }
  });
});
