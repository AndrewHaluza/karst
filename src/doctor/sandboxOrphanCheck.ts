import type { DoctorCheck } from './types.js';

export interface OrphanSandbox {
  readonly name: string;
  readonly ticketId: number;
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
    detail: `sandbox ${o.name} belongs to ticket ${o.ticketId}, which is not live`,
    fix: {
      tier: 'report',
      summary: 'orphan sandbox',
      nextStep: 'run "Karst: Clean Up Orphan Sandboxes" and confirm (unsynced commits in it are lost)',
    },
  }));
}
