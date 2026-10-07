import { describe, it, expect } from 'vitest';
import { providerConfirmsLaunch } from './provider.js';

describe('providerConfirmsLaunch', () => {
  it('is true for every core whose launch emits a SessionStart', () => {
    expect(providerConfirmsLaunch('claude')).toBe(true);
    expect(providerConfirmsLaunch('codex')).toBe(true);
    expect(providerConfirmsLaunch('antigravity')).toBe(true);
    expect(providerConfirmsLaunch('opencode')).toBe(true);
  });

  it('is false for opencode2, whose launch has no confirmation path yet', () => {
    expect(providerConfirmsLaunch('opencode2')).toBe(false);
  });
});
