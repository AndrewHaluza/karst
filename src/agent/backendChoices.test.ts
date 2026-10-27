import { describe, expect, it } from 'vitest';
import { allowedBackends, backendCoreKey, backendForCore, type AgentBackends } from './backendChoices.js';

describe('backendChoices', () => {
  it('maps antigravity to agy in backendCoreKey and leaves other cores unchanged', () => {
    expect(backendCoreKey('antigravity')).toBe('agy');
    expect(backendCoreKey('agy')).toBe('agy');
    expect(backendCoreKey('claude')).toBe('claude');
    expect(backendCoreKey('opencode')).toBe('opencode');
  });

  it('returns host and docker for both agy and antigravity', () => {
    expect(allowedBackends('agy')).toEqual(['host', 'docker']);
    expect(allowedBackends('antigravity')).toEqual(['host', 'docker']);
    expect(allowedBackends('claude')).toEqual(['host', 'sbx']);
  });

  it('checks exact key first, then mapped key, defaulting to host', () => {
    const backends: AgentBackends = { agy: 'docker' };
    expect(backendForCore(backends, 'agy')).toBe('docker');
    expect(backendForCore(backends, 'antigravity')).toBe('docker');

    // Per-ticket override with exact 'antigravity' key takes precedence over 'agy'
    const overridden = { agy: 'docker', antigravity: 'host' } as unknown as AgentBackends;
    expect(backendForCore(overridden, 'antigravity')).toBe('host');
    expect(backendForCore(overridden, 'agy')).toBe('docker');

    expect(backendForCore(undefined, 'antigravity')).toBe('host');
    expect(backendForCore({}, 'unknown')).toBe('host');
  });
});
