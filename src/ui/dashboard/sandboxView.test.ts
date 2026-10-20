import { describe, expect, it } from 'vitest';
import { buildSandboxView } from './sandboxView.js';

describe('buildSandboxView', () => {
  it('is absent when no project backend is configured, or the project is host', () => {
    expect(buildSandboxView({ project: undefined, ticketOverride: null, core: 'claude' })).toBeNull();
    expect(buildSandboxView({ project: 'host', ticketOverride: null, core: 'claude' })).toBeNull();
  });

  it('sbx for claude and codex: clone workspace, sbx policy network, actions available', () => {
    for (const core of ['claude', 'codex']) {
      expect(buildSandboxView({ project: 'sbx', ticketOverride: null, core })).toEqual({
        backend: 'sbx', core, workspace: 'clone', network: 'sbx network policy (allowlist)', actions: true, carry: false,
      });
    }
  });

  it('docker for the opencode cores', () => {
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'opencode2' })).toEqual({
      backend: 'docker', core: 'opencode2', workspace: 'clone', network: 'allowlist proxy on an internal network', actions: true, carry: false,
    });
  });

  it('a core the backend cannot host runs prompted on host, with the reason and no actions', () => {
    expect(buildSandboxView({ project: 'sbx', ticketOverride: null, core: 'antigravity' })).toEqual({
      backend: 'host', core: 'antigravity', workspace: 'worktree', network: 'none (host)', actions: false, carry: false,
      note: 'antigravity: sbx backend unsupported',
    });
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'claude' })).toMatchObject({ backend: 'host', note: 'claude: docker backend unsupported' });
  });

  it('a ticket opt-out shows host with that reason, but keeps actions for a sandbox it already has', () => {
    expect(buildSandboxView({ project: 'sbx', ticketOverride: 'host', core: 'claude' })).toEqual({
      backend: 'host', core: 'claude', workspace: 'worktree', network: 'none (host)', actions: true, carry: false, note: 'ticket opted out of the sandbox backend',
    });
  });

  it('offers the carry only for a sandboxed ticket whose host branch was rewritten', () => {
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'opencode2', rewritten: true })).toMatchObject({ carry: true });
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'opencode2', rewritten: false })).toMatchObject({ carry: false });
    expect(buildSandboxView({ project: 'sbx', ticketOverride: 'host', core: 'claude', rewritten: true })).toMatchObject({ carry: false });
    expect(buildSandboxView({ project: 'sbx', ticketOverride: null, core: 'antigravity', rewritten: true })).toMatchObject({ carry: false });
  });
});
