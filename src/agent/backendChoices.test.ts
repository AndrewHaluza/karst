import { describe, expect, it } from 'vitest';
import {
  BACKEND_CORE_PROVIDER,
  BACKEND_CORES,
  allowedBackends,
  backendCoreKey,
  backendForCore,
  isSshBackend,
  parseSshBackend,
  selectedRemotes,
  selectedSandboxBackends,
  sshAllowed,
  wantedBackends,
  type AgentBackends,
} from './backendChoices.js';

describe('backendChoices', () => {
  it('maps every backend core to the session provider that serves it (SET-46)', () => {
    // Exhaustive by construction (`Record<BackendCore, AgentProvider>`), and the
    // one asymmetric entry is the whole point: the manifest says `agy`, the
    // session providers say `antigravity`.
    for (const core of BACKEND_CORES) {
      expect(BACKEND_CORE_PROVIDER[core], core).toBeTruthy();
    }
    expect(BACKEND_CORE_PROVIDER.agy).toBe('antigravity');
    expect(BACKEND_CORE_PROVIDER.claude).toBe('claude');
    expect(Object.keys(BACKEND_CORE_PROVIDER).sort()).toEqual([...BACKEND_CORES].sort());
  });

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

  it('parses an ssh:<name> backend and recognises the kind', () => {
    expect(parseSshBackend('ssh:devbox')).toBe('devbox');
    expect(isSshBackend('ssh:devbox')).toBe(true);
    expect(parseSshBackend('host')).toBeUndefined();
    expect(parseSshBackend('sbx')).toBeUndefined();
    expect(parseSshBackend('docker')).toBeUndefined();
    expect(parseSshBackend('ssh:')).toBeUndefined();
    expect(isSshBackend('ssh:')).toBe(false);
  });

  it('allows ssh only for the SSH cores: agy and antigravity never', () => {
    expect(sshAllowed('claude')).toBe(true);
    expect(sshAllowed('codex')).toBe(true);
    expect(sshAllowed('opencode')).toBe(true);
    expect(sshAllowed('opencode2')).toBe(true);
    expect(sshAllowed('agy')).toBe(false);
    expect(sshAllowed('antigravity')).toBe(false);
  });

  it('maps every ssh:<name> value to the ssh sandbox kind and keeps selectedRemotes', () => {
    const backends: AgentBackends = { claude: 'ssh:devbox', codex: 'sbx', opencode: 'ssh:other' };
    expect(selectedSandboxBackends(backends)).toEqual(['sbx', 'ssh']);
    expect(selectedRemotes(backends)).toEqual(['devbox', 'other']);
    expect(wantedBackends(backends)).toEqual({ sbx: true, docker: false, ssh: true });
    expect(selectedSandboxBackends({ claude: 'host' })).toEqual([]);
    expect(selectedRemotes(undefined)).toEqual([]);
  });
});
