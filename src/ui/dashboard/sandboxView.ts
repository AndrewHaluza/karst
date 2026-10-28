import type { AgentBackend } from '../../manifest/types.js';
import { DOCKER_CORES, SBX_CORES } from '../../agent/sandboxCores.js';
import type { TicketPlacement } from '../../store/placement.js';

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
  /** Host runs only: the core's built-in OS sandbox is active (AC-31) or tool use is prompted. */
  readonly hostProtection?: 'core-native' | 'prompted';
}

export interface SandboxViewInput {
  readonly project?: AgentBackend | undefined;
  readonly ticketOverride: 'host' | null | undefined;
  readonly core: string;
  /** The last refused sync was a host rewrite (rebase/amend). */
  readonly rewritten?: boolean;
  /** The manifest's `agentSandbox` opt-in (AC-31). */
  readonly agentSandbox?: boolean;
  /** The recorded placement (D245/T772). When present, backend and core come from it. */
  readonly placement?: TicketPlacement | null;
}

/** Cores whose adapter declares `surfaces.sandboxInteractive` (claude seatbelt/bubblewrap, codex workspace-write). */
const NATIVE_SANDBOX_CORES: readonly string[] = ['claude', 'codex'];

const NETWORK: Readonly<Record<AgentBackend, string>> = {
  host: 'none (host)',
  sbx: 'sbx network policy (allowlist)',
  docker: 'allowlist proxy on an internal network',
};

/**
 * The configured placement, not a live probe (the preflight is async and runs at
 * session start, which shows its own fallback message). Always present: a host
 * run still reports where it runs and whether the core's own OS sandbox guards it.
 */
export function buildSandboxView(input: SandboxViewInput): DashboardSandboxView {
  const placement = input.placement;
  const core = placement?.core ?? input.core;
  const hostProtection = input.agentSandbox === true && NATIVE_SANDBOX_CORES.includes(core) ? 'core-native' : 'prompted';
  const onHost = (actions: boolean, note?: string): DashboardSandboxView => ({
    backend: 'host', core, workspace: 'worktree', network: NETWORK.host, actions, carry: false, hostProtection,
    ...(note === undefined ? {} : { note }),
  });

  if (placement) {
    if (placement.backend === 'host') {
      if (input.ticketOverride === 'host') return onHost(true, 'ticket opted out of the sandbox backend');
      return onHost(false);
    }
    return {
      backend: placement.backend,
      core,
      workspace: 'clone',
      network: NETWORK[placement.backend],
      actions: true,
      carry: input.rewritten === true,
    };
  }

  const { project } = input;
  if (project === undefined || project === 'host') return onHost(false);
  // An opted-out ticket may still hold a sandbox from before, so its actions stay.
  if (input.ticketOverride === 'host') return onHost(true, 'ticket opted out of the sandbox backend');
  const cores: readonly string[] = project === 'sbx' ? SBX_CORES : DOCKER_CORES;
  if (!cores.includes(core)) return onHost(false, `${core}: ${project} backend unsupported`);
  return { backend: project, core, workspace: 'clone', network: NETWORK[project], actions: true, carry: input.rewritten === true };
}
