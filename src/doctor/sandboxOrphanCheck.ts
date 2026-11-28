import type { DoctorCheck } from './types.js';

export interface OrphanSandbox {
  readonly name: string;
  readonly ticketId: number;
  /** The `remotes.<name>` of an ssh workspace (D824): named in the line so two remotes never look alike. */
  readonly remote?: string;
}

/** `sandbox <name>` or `sandbox <name> on <remote>`: an ssh orphan names its remote. */
function label(o: OrphanSandbox): string {
  return o.remote === undefined ? `sandbox ${o.name}` : `sandbox ${o.name} on ${o.remote}`;
}

/**
 * Sandboxes of THIS project with no live ticket (arch:AC-32). Report-only:
 * removal is the confirmed `Karst: Clean Up Orphan Sandboxes` command, never a fix.
 */
export function checkSandboxOrphans(orphans: readonly OrphanSandbox[]): DoctorCheck[] {
  return orphans.map((o) => ({
    id: `state.sandbox-orphan.${o.name}`,
    area: 'state',
    status: 'warn',
    detail: `${label(o)} belongs to ticket ${o.ticketId}, which is not live`,
    fix: {
      tier: 'report',
      summary: 'orphan sandbox',
      nextStep: 'run "Karst: Clean Up Orphan Sandboxes" and confirm (unsynced commits in it are lost)',
    },
  }));
}

export interface ForgottenRemoteWorkspace {
  readonly name: string;
  readonly ticketId: number;
  readonly remote: string;
}

/**
 * Forgotten remote workspaces (`ssh-strays.json`, D824 edit 2). Report-only, and never an orphan:
 * the orphan cleanup skips a stray, so only its Delete on the ticket removes it (D830).
 */
export function checkForgottenRemoteWorkspaces(strays: readonly ForgottenRemoteWorkspace[]): DoctorCheck[] {
  return strays.map((s) => ({
    id: `state.sandbox-stray.${s.remote}.${s.name}`,
    area: 'state',
    status: 'warn',
    detail: `forgotten remote workspace ${s.name} on ${s.remote} (ticket ${s.ticketId})`,
    fix: {
      tier: 'report',
      summary: 'forgotten remote workspace',
      nextStep: 'delete it from the ticket (the orphan cleanup never removes it)',
    },
  }));
}
