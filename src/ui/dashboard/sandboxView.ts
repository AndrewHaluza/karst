import type { AgentBackend } from '../../manifest/types.js';
import { DOCKER_CORES, SBX_CORES } from '../../agent/sandboxCores.js';

/** The dashboard's Sandbox card (arch:AC-32): where this ticket's session runs and what it may do about it. */
export interface DashboardSandboxView {
  readonly backend: AgentBackend;
  readonly core: string;
  /** `clone` for a sandbox (never a direct worktree mount), `worktree` on host. */
  readonly workspace: 'clone' | 'worktree';
  readonly network: string;
  /** Sync / diff / stop / remove apply: a sandbox may exist for this ticket. */
  readonly actions: boolean;
  /** The host branch was rewritten under the sandbox: "Carry sandbox commits onto host branch" applies. */
  readonly carry: boolean;
  /** Why the ticket is on host although the project selects a sandbox backend. */
  readonly note?: string;
}

export interface SandboxViewInput {
  readonly project: AgentBackend | undefined;
  readonly ticketOverride: 'host' | null | undefined;
  readonly core: string;
  /** The last refused sync was a host rewrite (rebase/amend). */
  readonly rewritten?: boolean;
}

const NETWORK: Readonly<Record<AgentBackend, string>> = {
  host: 'none (host)',
  sbx: 'sbx network policy (allowlist)',
  docker: 'allowlist proxy on an internal network',
};

/**
 * The configured placement, not a live probe (the preflight is async and runs at
 * session start, which shows its own fallback message). Absent when the project
 * uses no sandbox backend, so a host project's dashboard is unchanged.
 */
export function buildSandboxView(input: SandboxViewInput): DashboardSandboxView | null {
  const { project, core } = input;
  if (project === undefined || project === 'host') return null;
  const onHost = (note: string, actions: boolean): DashboardSandboxView => ({
    backend: 'host', core, workspace: 'worktree', network: NETWORK.host, actions, carry: false, note,
  });
  // An opted-out ticket may still hold a sandbox from before, so its actions stay.
  if (input.ticketOverride === 'host') return onHost('ticket opted out of the sandbox backend', true);
  const cores: readonly string[] = project === 'sbx' ? SBX_CORES : DOCKER_CORES;
  if (!cores.includes(core)) return onHost(`${core}: ${project} backend unsupported`, false);
  return { backend: project, core, workspace: 'clone', network: NETWORK[project], actions: true, carry: input.rewritten === true };
}
