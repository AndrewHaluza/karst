import { describe, it, expect } from 'vitest';
import { suggestSignals } from './suggest.js';
import type { AgentAdapter, HeadlessResult } from '../../agent/adapter.js';

/** A fake adapter whose runHeadless returns a canned raw string. */
function fakeAdapter(raw: string): AgentAdapter {
  return {
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    async runHeadless(): Promise<HeadlessResult> {
      return { sessionId: 's1', verdict: null, raw };
    },
  };
}

function rejectingAdapter(): AgentAdapter {
  return {
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    runHeadless: () => Promise.reject(new Error('agent unavailable')),
  };
}

describe('suggestSignals', () => {
  it('parses a JSON array of signal words from the agent result', async () => {
    const adapter = fakeAdapter('["api", "endpoint", "migration"]');
    const signals = await suggestSignals(adapter, { service: 'backend', repoPath: '/be' });
    expect(signals).toEqual(['api', 'endpoint', 'migration']);
  });

  it('parses signals embedded in surrounding prose', async () => {
    const adapter = fakeAdapter('Here are the signals:\n["ui", "react"]\nHope that helps.');
    const signals = await suggestSignals(adapter, { service: 'frontend', repoPath: '/fe' });
    expect(signals).toEqual(['ui', 'react']);
  });

  it('lowercases, trims, and de-duplicates suggested words', async () => {
    const adapter = fakeAdapter('["UI", "ui", "  React  ", "react"]');
    const signals = await suggestSignals(adapter, { service: 'fe', repoPath: '/fe' });
    expect(signals).toEqual(['ui', 'react']);
  });

  it('returns [] when the result has no parseable array (manual fallback)', async () => {
    const adapter = fakeAdapter('I could not determine any signals.');
    const signals = await suggestSignals(adapter, { service: 'x', repoPath: '/x' });
    expect(signals).toEqual([]);
  });

  it('propagates the adapter rejection so the caller can fall back to manual', async () => {
    await expect(
      suggestSignals(rejectingAdapter(), { service: 'x', repoPath: '/x' }),
    ).rejects.toThrow(/unavailable/);
  });

  it('drops multi-word phrases the scorer can never match', async () => {
    const adapter = fakeAdapter('["dark mode", "state machine", "i18n", "vue"]');
    const signals = await suggestSignals(adapter, { service: 'fe', repoPath: '/fe' });
    // "dark mode" / "state machine" contain spaces → the [a-z0-9]+ scorer can't
    // hit them; only single-token words survive.
    expect(signals).toEqual(['i18n', 'vue']);
  });

  it('drops generic engineering/test junk words', async () => {
    const adapter = fakeAdapter(
      '["test", "e2e", "vitest", "cypress", "build", "ci", "lint", "css", "config", "vue", "timer"]',
    );
    const signals = await suggestSignals(adapter, { service: 'fe', repoPath: '/fe' });
    expect(signals).toEqual(['vue', 'timer']);
  });

  it('hard-caps the list to at most 12 words', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `sig${i}`);
    const adapter = fakeAdapter(JSON.stringify(many));
    const signals = await suggestSignals(adapter, { service: 'fe', repoPath: '/fe' });
    expect(signals).toHaveLength(12);
    expect(signals[0]).toBe('sig0');
  });

  it('drops hyphenated words — the scorer splits on non-alphanumerics', async () => {
    // The scorer tokenizes with [a-z0-9]+, so "sign-in" becomes sign/in and a
    // hyphenated signal can never match as one token. Keep only pure a-z0-9.
    const adapter = fakeAdapter('["sign-in", "vue"]');
    const signals = await suggestSignals(adapter, { service: 'fe', repoPath: '/fe' });
    expect(signals).toEqual(['vue']);
  });
});
