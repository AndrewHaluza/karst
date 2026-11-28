import type { ProjectSandbox } from '../agent/sandboxInventory.js';
import type { AttributedRow } from './resourceInventory.js';

/**
 * Remote workspaces in the Resources read model (D824, edit 7).
 *
 * A remote workspace is a row the user can see — its remote, its state and its
 * disk — but it is NOT host cost: it runs on another machine. So its row has
 * `cost: null` (every total and the memory-pressure check skip it), and its
 * facts live in the label until the Resources table grows dedicated columns.
 *
 * The disk and the age come from one trusted probe (`du -sk`, and the mtime of
 * `<ws>/env/env.sh` for the last launch); without it the label says
 * `disk unknown`, never `0 B` (a measured-looking zero, RS-23), and no age.
 */

/** One ssh workspace of this project, as the Resources view lists it. */
export interface RemoteWorkspaceFact {
  readonly remote: string;
  readonly name: string;
  readonly ticketId: number;
  readonly state: 'running' | 'stopped';
  /** `du -sk` of `<ws>`; absent when the remote was not asked (no ssh for an unconfirmed remote). */
  readonly sizeKb?: number;
  /** Whole days since the last launch; absent when the remote was not asked. */
  readonly ageDays?: number;
}

/** The probed facts of one workspace: its disk and the whole days since its last launch. */
export interface RemoteWorkspaceProbeFacts {
  readonly sizeKb: number;
  readonly ageDays: number;
}

/** The key a size probe is filed under. */
export function remoteWorkspaceKey(remote: string, name: string): string {
  return `${remote}/${name}`;
}

export function formatRemoteKb(kb: number): string {
  return kb >= 1024 ** 2 ? `${(kb / 1024 ** 2).toFixed(1)} GB` : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

/** `ssh devbox · stopped 3 days · 1.2 GB`: the row's one label, built host-side like every other display string. */
export function remoteWorkspaceLabel(fact: RemoteWorkspaceFact): string {
  const disk = fact.sizeKb === undefined ? 'disk unknown' : formatRemoteKb(fact.sizeKb);
  // A stopped workspace shows the age since its last launch, the fact that tells an old one to remove (edit 12).
  const state = fact.state === 'stopped' && fact.ageDays !== undefined
    ? `stopped ${String(fact.ageDays)} ${fact.ageDays === 1 ? 'day' : 'days'}`
    : fact.state;
  return `ssh ${fact.remote} · ${state} · ${disk}`;
}

/** The ssh sandboxes of an inventory as Resources facts; a probe map is keyed by `remote/name`. */
export function remoteWorkspaceFacts(
  sandboxes: readonly ProjectSandbox[],
  probes?: ReadonlyMap<string, RemoteWorkspaceProbeFacts>,
): RemoteWorkspaceFact[] {
  return sandboxes.flatMap((s) => {
    if (s.runner !== 'ssh' || s.remote === undefined) return [];
    const probe = probes?.get(remoteWorkspaceKey(s.remote, s.name));
    return [{ remote: s.remote, name: s.name, ticketId: s.ticketId, state: s.state, ...(probe === undefined ? {} : { sizeKb: probe.sizeKb, ageDays: probe.ageDays }) }];
  });
}

/** The Resources rows: remote, state and disk in the label, and no host cost (never in the totals). */
export function remoteWorkspaceRows(facts: readonly RemoteWorkspaceFact[]): AttributedRow[] {
  return facts.map((f) => ({
    pid: 0,
    kind: 'remote',
    ticketId: f.ticketId,
    label: remoteWorkspaceLabel(f),
    serverId: null,
    attribution: 'attributable',
    cost: null,
    cwd: null,
    comm: f.name,
  }));
}
