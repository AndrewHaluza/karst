/**
 * Apply and diff a proposed `karst.yml` against the current one.
 *
 * The setup agent reads the current manifest and proposes a MINIMAL edit that
 * only adds or corrects repositories and services. This module is the host-side
 * enforcement of that contract: `applyManifestProposal` NEVER lets a proposal
 * change a protected field — identity (`id`), agent settings, presets,
 * processes, ticketing, gates and conventions are taken from the current
 * manifest, only `repositories` (and a brand-new manifest) come from the
 * proposal. That is why the user can approve a diff without fear that accepting
 * a discovered service resets their board or their model choices.
 *
 * `diffManifest` is pure and display-only: it lists what changed per repository
 * and, separately, EVERY start command the proposed manifest would run — the
 * list the user approves before karst is allowed to spin anything.
 */

import type { DockerDef, Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';

/** Top-level fields a setup proposal may never change. */
const PROTECTED_FIELDS = [
  'id',
  'host',
  'portRange',
  'baselineBranch',
  'worktreePathDisplay',
  'ticketLabelTemplate',
  'terminalNameTemplate',
  'conventions',
  'ticketing',
  'agentProvider',
  'defaultModel',
  'resilience',
  'defaultEffort',
  'agentPresets',
  'activeAgentPreset',
  'defaultAgentPreset',
  'archiveDoneAfterDays',
  'subtasks',
  'debug',
  'closeDoneTerminalsWithTicket',
  'diffsInSourceControl',
  'uat',
  'review',
  'processes',
  'approaches',
  'agents',
] as const;

export type ProtectedField = (typeof PROTECTED_FIELDS)[number];

/**
 * Required protected fields and their scaffold defaults, used when there is no
 * current manifest to restore them from (greenfield, or an unreadable file).
 */
const SCAFFOLD_DEFAULTS = {
  host: '127.0.0.1',
  portRange: [4000, 4100],
  baselineBranch: 'develop',
} as const;

/**
 * The manifest to actually write: the proposal's `repositories`, with every
 * protected field restored from `current`. With no current manifest (a
 * greenfield scaffold, or a file that failed to load), protected fields are
 * still stripped from the proposal and the required ones filled with the
 * scaffold defaults — the consent modal never showed them, so they can never
 * reach the written file.
 */
export function applyManifestProposal(current: Manifest | undefined, proposed: Manifest): Manifest {
  const next = { ...proposed } as unknown as Record<string, unknown>;
  for (const field of PROTECTED_FIELDS) {
    const value = current === undefined ? undefined : (current as unknown as Record<string, unknown>)[field];
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  if (current === undefined) {
    next.host = SCAFFOLD_DEFAULTS.host;
    next.portRange = [...SCAFFOLD_DEFAULTS.portRange] as [number, number];
    next.baselineBranch = SCAFFOLD_DEFAULTS.baselineBranch;
  }
  return next as unknown as Manifest;
}

export interface ManifestDiffEntry {
  repo: string;
  kind: 'added' | 'removed' | 'changed';
  details: string[];
}

export interface StartCommand {
  repo: string;
  command: string;
}

export interface ManifestDiff {
  entries: ManifestDiffEntry[];
  /** Every start command the PROPOSED manifest will run, in repository order. */
  startCommands: StartCommand[];
  /** True when the set of (repo -> start) pairs differs from the current one. */
  startCommandsChanged: boolean;
}

/** Every service start command in a manifest, keyed by repository name. */
export function listStartCommands(manifest: Manifest | undefined): StartCommand[] {
  if (manifest === undefined) return [];
  const out: StartCommand[] = [];
  for (const [repo, def] of Object.entries(manifest.repositories)) {
    const svc = def.service;
    if (svc === undefined) continue;
    if (svc.start !== undefined && svc.start !== '') out.push({ repo, command: svc.start });
    else if (svc.docker !== undefined) out.push({ repo, command: `docker run ${svc.docker.image}` });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}

function dockerChanged(before: DockerDef | undefined, after: DockerDef | undefined): string[] {
  const details: string[] = [];
  if (before === undefined && after === undefined) return details;
  if (before === undefined) return ['added a docker service'];
  if (after === undefined) return ['removed the docker service'];
  if (before.image !== after.image) details.push(`docker image: ${before.image} -> ${after.image}`);
  if (before.containerPort !== after.containerPort) {
    details.push(`docker containerPort: ${before.containerPort} -> ${after.containerPort}`);
  }
  const envKey = (e: Record<string, string>) => Object.keys(e).sort().map((k) => `${k}=${e[k]}`).join(', ');
  if (envKey(before.env) !== envKey(after.env)) details.push('docker env changed');
  const vols = (v: string[]) => [...v].sort().join(', ');
  if (vols(before.volumes) !== vols(after.volumes)) details.push('docker volumes changed');
  const args = (a: string[]) => [...a].sort().join(' ');
  if (args(before.args) !== args(after.args)) details.push('docker args changed');
  return details;
}

function serviceChanged(before: ServiceDef | undefined, after: ServiceDef | undefined): string[] {
  const details: string[] = [];
  if (before === undefined && after === undefined) return details;
  if (before === undefined) return ['added a service'];
  if (after === undefined) return ['removed the service'];
  if (before.start !== after.start) details.push(`start: ${before.start || '(docker)'} -> ${after.start || '(docker)'}`);
  if (before.health !== after.health) details.push(`health: ${before.health ?? '(default)'} -> ${after.health ?? '(default)'}`);
  const beforePorts = before.ports.map((p) => `${p.env}=${p.default}`).join(', ');
  const afterPorts = after.ports.map((p) => `${p.env}=${p.default}`).join(', ');
  if (beforePorts !== afterPorts) details.push(`ports: ${beforePorts} -> ${afterPorts}`);
  if (before.dependsOn.length !== after.dependsOn.length) details.push('dependsOn changed');
  if (before.healthIdentity !== after.healthIdentity) details.push('healthIdentity changed');
  details.push(...dockerChanged(before.docker, after.docker));
  return details;
}

function repoChanged(before: RepositoryDef | undefined, after: RepositoryDef | undefined): string[] {
  if (before === undefined || after === undefined) return [];
  const details: string[] = [];
  if (before.repoPath !== after.repoPath) details.push(`repoPath: ${before.repoPath} -> ${after.repoPath}`);
  if ((before.baselineBranch ?? '') !== (after.baselineBranch ?? '')) {
    details.push(`baselineBranch: ${before.baselineBranch ?? '(default)'} -> ${after.baselineBranch ?? '(default)'}`);
  }
  details.push(...serviceChanged(before.service, after.service));
  return details;
}

export function diffManifest(current: Manifest | undefined, proposed: Manifest): ManifestDiff {
  const entries: ManifestDiffEntry[] = [];
  const currentRepos = current?.repositories ?? {};
  const proposedRepos = proposed.repositories;

  for (const repo of Object.keys(proposedRepos).sort()) {
    const after = proposedRepos[repo]!;
    const before = currentRepos[repo];
    if (before === undefined) {
      const details = [`repoPath: ${after.repoPath}`];
      if (after.baselineBranch) details.push(`baselineBranch: ${after.baselineBranch}`);
      const svc = serviceChanged(undefined, after.service);
      entries.push({ repo, kind: 'added', details: [...details, ...(svc.length ? svc : ['no service']) ] });
      continue;
    }
    const details = repoChanged(before, after);
    if (details.length > 0) entries.push({ repo, kind: 'changed', details });
  }
  for (const repo of Object.keys(currentRepos).sort()) {
    if (!(repo in proposedRepos)) entries.push({ repo, kind: 'removed', details: ['removed'] });
  }

  const startCommands = listStartCommands(proposed);
  const beforeStart = listStartCommands(current);
  const key = (list: StartCommand[]) => list.map((s) => `${s.repo}=${s.command}`).sort().join('|');
  return {
    entries,
    startCommands,
    startCommandsChanged: key(beforeStart) !== key(startCommands),
  };
}
