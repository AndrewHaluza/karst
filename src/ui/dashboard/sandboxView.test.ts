import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { buildSandboxView } from './sandboxView.js';
import { buildSandbox } from './stateAgent.js';

describe('buildSandboxView', () => {
  it('a host project (or none) still gets a host view, protected by the core OS sandbox only when opted in and supported', () => {
    for (const project of [undefined, 'host'] as const) {
      expect(buildSandboxView({ project, ticketOverride: null, core: 'claude' })).toEqual({
        backend: 'host', core: 'claude', workspace: 'worktree', network: 'none (host)', actions: false, carry: false, hostProtection: 'prompted', shell: { available: false, why: 'No sandbox yet' },
      });
    }
    expect(buildSandboxView({ project: 'host', ticketOverride: null, core: 'codex', agentSandbox: true })).toMatchObject({ hostProtection: 'core-native' });
    expect(buildSandboxView({ project: undefined, ticketOverride: null, core: 'claude', agentSandbox: true })).toMatchObject({ hostProtection: 'core-native' });
    expect(buildSandboxView({ project: 'host', ticketOverride: null, core: 'opencode2', agentSandbox: true })).toMatchObject({ hostProtection: 'prompted' });
    expect(buildSandboxView({ project: 'host', ticketOverride: null, core: 'claude', agentSandbox: false })).toMatchObject({ hostProtection: 'prompted' });
  });

  it('host fallbacks from a sandbox project carry hostProtection too, and sandboxed views do not', () => {
    expect(buildSandboxView({ project: 'sbx', ticketOverride: 'host', core: 'claude', agentSandbox: true })).toMatchObject({ backend: 'host', hostProtection: 'core-native' });
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'claude' })).toMatchObject({ hostProtection: 'prompted' });
    expect(buildSandboxView({ project: 'sbx', ticketOverride: null, core: 'claude', agentSandbox: true })).not.toHaveProperty('hostProtection');
  });

  it('sbx for claude and codex: clone workspace, sbx policy network, actions available', () => {
    for (const core of ['claude', 'codex']) {
      expect(buildSandboxView({ project: 'sbx', ticketOverride: null, core })).toEqual({
        backend: 'sbx', core, workspace: 'clone', network: 'sbx network policy (allowlist)', actions: true, carry: false, shell: { available: false, why: 'No sandbox yet' },
      });
    }
  });

  it('docker for the opencode cores', () => {
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'opencode2' })).toEqual({
      backend: 'docker', core: 'opencode2', workspace: 'clone', network: 'allowlist proxy on an internal network', actions: true, carry: false, shell: { available: false, why: 'No sandbox yet' },
    });
  });

  it('a core the backend cannot host runs prompted on host, with the reason and no actions', () => {
    expect(buildSandboxView({ project: 'sbx', ticketOverride: null, core: 'antigravity' })).toEqual({
      backend: 'host', core: 'antigravity', workspace: 'worktree', network: 'none (host)', actions: false, carry: false, hostProtection: 'prompted', shell: { available: false, why: 'No sandbox yet' },
      note: 'antigravity: sbx backend unsupported',
    });
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'claude' })).toMatchObject({ backend: 'host', note: 'claude: docker backend unsupported' });
  });

  it('a ticket opt-out shows host with that reason, but keeps actions for a sandbox it already has', () => {
    expect(buildSandboxView({ project: 'sbx', ticketOverride: 'host', core: 'claude' })).toEqual({
      backend: 'host', core: 'claude', workspace: 'worktree', network: 'none (host)', actions: true, carry: false, hostProtection: 'prompted', shell: { available: false, why: 'No sandbox yet' }, note: 'ticket opted out of the sandbox backend',
    });
  });

  it('offers the carry only for a sandboxed ticket whose host branch was rewritten', () => {
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'opencode2', rewritten: true })).toMatchObject({ carry: true });
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'opencode2', rewritten: false })).toMatchObject({ carry: false });
    expect(buildSandboxView({ project: 'sbx', ticketOverride: 'host', core: 'claude', rewritten: true })).toMatchObject({ carry: false });
    expect(buildSandboxView({ project: 'sbx', ticketOverride: null, core: 'antigravity', rewritten: true })).toMatchObject({ carry: false });
  });

  it('builds strip from recorded placement directly, ignoring project', () => {
    // Host placement with core claude, project configured as docker
    expect(buildSandboxView({
      project: 'docker',
      ticketOverride: null,
      core: 'opencode2',
      placement: { backend: 'host', core: 'claude', sandboxName: null, reason: 'agentBackends.claude: host' },
    })).toEqual({
      backend: 'host',
      core: 'claude',
      workspace: 'worktree',
      network: 'none (host)',
      actions: false,
      carry: false,
      hostProtection: 'prompted',
      shell: { available: false, why: 'No sandbox yet' },
    });

    // Host placement with no core: falls back to input.core
    expect(buildSandboxView({
      project: 'docker',
      ticketOverride: null,
      core: 'claude',
      placement: { backend: 'host', core: null, sandboxName: null, reason: 'host' },
    })).toMatchObject({
      backend: 'host',
      core: 'claude',
      workspace: 'worktree',
      actions: false,
    });

    // Docker placement with core opencode2, project configured as host/undefined
    expect(buildSandboxView({
      project: 'host',
      ticketOverride: null,
      core: 'claude',
      placement: { backend: 'docker', core: 'opencode2', sandboxName: 'karst-1', reason: null },
    })).toEqual({
      backend: 'docker',
      core: 'opencode2',
      workspace: 'clone',
      network: 'allowlist proxy on an internal network',
      actions: true,
      carry: false,
      shell: { available: false, why: 'No sandbox yet' },
    });

    // Host placement with ticket override 'host': keeps actions and opt-out note
    expect(buildSandboxView({
      project: 'host',
      ticketOverride: 'host',
      core: 'claude',
      placement: { backend: 'host', core: 'claude', sandboxName: null, reason: 'opted out' },
    })).toMatchObject({
      backend: 'host',
      actions: true,
      note: 'ticket opted out of the sandbox backend',
    });
  });

  it('carries the host shell probe on a sandbox view and on an opted-out host that keeps its sandbox, never on a plain host', () => {
    const shell = { available: true, why: null };
    expect(buildSandboxView({ project: 'sbx', ticketOverride: null, core: 'claude', shell })).toMatchObject({ shell });
    expect(buildSandboxView({ project: 'sbx', ticketOverride: 'host', core: 'claude', shell })).toMatchObject({ shell });
    expect(buildSandboxView({ project: 'host', ticketOverride: null, core: 'claude', shell })).toMatchObject({ shell: { available: false, why: 'No sandbox yet' } });
    expect(buildSandboxView({ project: 'docker', ticketOverride: null, core: 'opencode2', shell: { available: false, why: 'Sandbox is stopped' } }))
      .toMatchObject({ shell: { available: false, why: 'Sandbox is stopped' } });
  });
});

describe('buildSandbox shell probe', () => {
  const ok = { available: true, why: null };
  it('probes only for a ticket that resolves to a sandbox backend', () => {
    const sandboxShell = vi.fn().mockReturnValue(ok);
    const ctx = { agentBackends: { claude: 'sbx' } as never, sandboxShell };
    expect(buildSandbox(ctx, { id: 1 }, 'claude')).toMatchObject({ backend: 'sbx', shell: ok });
    expect(sandboxShell).toHaveBeenCalledWith(1);
  });
  it('never probes for a host project, a ticket opt-out or a host placement', () => {
    const sandboxShell = vi.fn().mockReturnValue(ok);
    const sbxCtx = { agentBackends: { claude: 'sbx' } as never, sandboxShell };
    expect(buildSandbox({ sandboxShell }, { id: 1 }, 'claude')).toMatchObject({ backend: 'host', shell: { available: false } });
    buildSandbox(sbxCtx, { id: 2, agentBackend: 'host' }, 'claude');
    buildSandbox(sbxCtx, { id: 3 }, 'claude', { backend: 'host' } as never);
    expect(sandboxShell).not.toHaveBeenCalled();
  });
});
