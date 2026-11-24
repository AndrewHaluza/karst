/**
 * Resolve a ticket's declared approach phases — the names and their order from
 * the installed package, the evidence kind from the manifest phase of the same
 * name.
 *
 * vscode-free, so it runs under vitest with fakes; `extension.ts` binds the real
 * package reader and the live manifest.
 */

import type { ApproachPhase } from '../artifacts/phaseEvidence.js';
import type { Manifest } from '../manifest/types.js';
import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';

export interface MakePhasesOfDeps {
  store: Store;
  manifest: () => Manifest | undefined;
  /** Read an installed approach package; `null`/absent when it is not installed. */
  packageOf: (approachId: string) => { workflow?: readonly { name: string }[] } | null | undefined;
  debug: (message: string) => void;
}

/**
 * Build the ticket → phases resolver. Never throws: a phase list is evidence the
 * host MAY have, so an unreadable manifest or package yields no phases and one
 * debug line — it must never fail a launch or a capture (`@arch:RESULTS`).
 */
export function makePhasesOf(deps: MakePhasesOfDeps): (ticketId: number) => readonly ApproachPhase[] {
  return (ticketId) => {
    try {
      const approachId = getTicket(deps.store, ticketId).approach;
      if (approachId === null || approachId === '') return [];
      const workflow = deps.packageOf(approachId)?.workflow;
      if (workflow === undefined) return [];
      // The manifest declares the evidence; the package declares the order. A
      // package phase with no manifest twin simply carries no evidence.
      const kinds = new Map<string, ApproachPhase['outputKind']>();
      const declared = deps.manifest()?.approaches?.find((a) => a.id === approachId)?.workflow;
      if (declared !== undefined) {
        for (const phase of declared) {
          if (phase.evidence !== undefined) kinds.set(phase.name, phase.evidence.outputKind);
        }
      }
      return workflow.map((phase) => {
        const outputKind = kinds.get(phase.name);
        return outputKind === undefined ? { name: phase.name } : { name: phase.name, outputKind };
      });
    } catch (err) {
      deps.debug(`[phases] could not resolve the approach phases of ticket ${ticketId}: ${String(err)}`);
      return [];
    }
  };
}
