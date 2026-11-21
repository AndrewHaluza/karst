/**
 * Apply and diff a proposed `karst.yml` against the current one.
 *
 * The setup agent reads the current manifest and proposes a MINIMAL edit that
 * only adds or corrects repositories and services. This module is the host-side
 * enforcement of that contract: `applyManifestProposal` NEVER lets a proposal
 * change a protected field — identity (`id`), agent settings, presets,
 * processes, ticketing, gates and conventions are taken from the current
 * manifest, only `repositories` come from the proposal — except on first setup
 * (no manifest, or an unedited scaffold), where protected fields other than
 * `id` come from the proposal too. That is why the user can approve a diff without fear that accepting
 * a discovered service resets their board or their model choices.
 *
 * `diffManifest` is pure and display-only: it lists what changed per repository
 * and, separately, EVERY start command the proposed manifest would run — the
 * list the user approves before karst is allowed to spin anything.
 */

import { isDeepStrictEqual } from 'node:util';
import { diffPaths, formatChange } from './pathDiff.js';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import { protectedKeys } from '../manifest/sectionTable.js';

/** Top-level fields a legacy setup proposal may never change: derived from the section table (@arch:FIELDCHK). */
const PROTECTED_FIELDS = protectedKeys();

export type ProtectedField = keyof Manifest;

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
 * True when `current` is still the unedited scaffold: every protected field
 * except `id` equals the bundled template's. Such a manifest has nothing worth
 * protecting, so the first setup proposal may set the protected fields.
 */
export function isScaffoldManifest(current: Manifest, template: Manifest | undefined): boolean {
  if (template === undefined) return false;
  const cur = current as unknown as Record<string, unknown>;
  const tpl = template as unknown as Record<string, unknown>;
  return PROTECTED_FIELDS.every((f) => f === 'id' || isDeepStrictEqual(cur[f], tpl[f]));
}

/**
 * First setup = no manifest yet, or an unedited scaffold: protected fields come
 * from the proposal (`id` still never does). Otherwise protected fields are
 * restored from `current`. With no current manifest the required fields are
 * filled with scaffold defaults when the proposal omits them.
 */
export function applyManifestProposal(
  current: Manifest | undefined,
  proposed: Manifest,
  firstSetup = current === undefined,
): Manifest {
  const next = { ...proposed } as unknown as Record<string, unknown>;
  const cur = current as unknown as Record<string, unknown> | undefined;
  for (const field of PROTECTED_FIELDS) {
    if (firstSetup && field !== 'id') continue;
    const value = cur?.[field];
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  if (firstSetup) {
    next.host ??= SCAFFOLD_DEFAULTS.host;
    next.portRange ??= [...SCAFFOLD_DEFAULTS.portRange] as [number, number];
    next.baselineBranch ??= SCAFFOLD_DEFAULTS.baselineBranch;
  }
  return next as unknown as Manifest;
}

/** Protected fields whose proposed value `applyManifestProposal` discards. */
export function droppedProtectedFields(
  current: Manifest | undefined,
  proposed: Manifest,
  firstSetup = current === undefined,
): ProtectedField[] {
  const applied = applyManifestProposal(current, proposed, firstSetup) as unknown as Record<string, unknown>;
  const prop = proposed as unknown as Record<string, unknown>;
  return PROTECTED_FIELDS.filter((f) => !isDeepStrictEqual(applied[f], prop[f]));
}

/** On first setup, the protected fields the proposal sets (shown before consent). */
export function adoptedProtectedFields(proposed: Manifest, firstSetup: boolean): ProtectedField[] {
  if (!firstSetup) return [];
  const prop = proposed as unknown as Record<string, unknown>;
  return PROTECTED_FIELDS.filter((f) => f !== 'id' && prop[f] !== undefined);
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

/** The start command of one service, or undefined when it runs nothing. */
function startOf(svc: ServiceDef): string | undefined {
  if (svc.start !== undefined && svc.start !== '') return svc.start;
  return svc.docker !== undefined ? `docker run ${svc.docker.image}` : undefined;
}

/** Every service start command in a manifest, keyed by repository name (a named service reads `repo/name`). */
export function listStartCommands(manifest: Manifest | undefined): StartCommand[] {
  if (manifest === undefined) return [];
  const out: StartCommand[] = [];
  for (const [repo, def] of Object.entries(manifest.repositories)) {
    const single = def.service === undefined ? undefined : startOf(def.service);
    if (single !== undefined) out.push({ repo, command: single });
    for (const [name, svc] of Object.entries(def.services ?? {})) {
      const command = startOf(svc);
      if (command !== undefined) out.push({ repo: `${repo}/${name}`, command });
    }
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}

/** The field-path changes of one repository, relative to it: a field added to the manifest later shows with no change here (@arch:CLI-21). */
function repoDetails(before: RepositoryDef | undefined, after: RepositoryDef | undefined): string[] {
  return diffPaths(before, after).map(formatChange);
}

export function diffManifest(current: Manifest | undefined, proposed: Manifest): ManifestDiff {
  const entries: ManifestDiffEntry[] = [];
  const currentRepos = current?.repositories ?? {};
  const proposedRepos = proposed.repositories;

  for (const repo of Object.keys(proposedRepos).sort()) {
    const before = currentRepos[repo];
    const details = repoDetails(before, proposedRepos[repo]);
    if (before === undefined) entries.push({ repo, kind: 'added', details });
    else if (details.length > 0) entries.push({ repo, kind: 'changed', details });
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
