/**
 * The section table (@arch:FIELDCHK): every top-level manifest key belongs to
 * exactly one section, and every section carries one protection decision.
 *
 * `SECTION_OF` is a `Record<keyof Manifest, ManifestSection>`: a key added to
 * `Manifest` without a section is a type error. `SECTION_PROTECTED` is a
 * `Record<ManifestSection, boolean>`: a new section without a decision is a
 * type error. The typed setup tools, the host build, the popup and the
 * protection rule all derive from these two tables.
 */

import type { SettingsSection } from '../ui/settings/sections.js';
import type { Manifest } from './types.js';

export type ManifestSection = SettingsSection | 'project';

export const SECTION_OF: Readonly<Record<keyof Manifest, ManifestSection>> = {
  id: 'project',
  resilience: 'project',
  artifacts: 'project',
  agentSandbox: 'project',
  sandboxMemory: 'project',
  sandboxLimits: 'project',
  analysis: 'project',
  host: 'general',
  portRange: 'general',
  baselineBranch: 'general',
  worktreePathDisplay: 'general',
  ticketLabelTemplate: 'general',
  terminalNameTemplate: 'general',
  archiveDoneAfterDays: 'general',
  archivePlanningAfterDays: 'general',
  debug: 'general',
  closeDoneTerminalsWithTicket: 'general',
  diffsInSourceControl: 'general',
  stopServersOnDone: 'general',
  subtasks: 'general',
  conventions: 'git',
  repositories: 'services',
  approaches: 'approaches',
  agentProvider: 'agents',
  defaultModel: 'agents',
  defaultEffort: 'agents',
  agents: 'agents',
  processes: 'agents',
  agentPresets: 'agents',
  activeAgentPreset: 'agents',
  defaultAgentPreset: 'agents',
  agentBackends: 'agents',
  remotes: 'agents',
  // Q4-SAVE: the Accounts quota card writes through `set-quota`, outside every
  // tab-scoped Save. No Settings section claims it, so it is a project key here
  // too — a Save can never overlay a stale quota block onto the file.
  quota: 'project',
  ticketing: 'ticketing',
  uat: 'quality',
  review: 'quality',
  autopilot: 'autopilot',
};

/**
 * Protected sections: a change to one of their keys is listed in its own block
 * of the popup, and a setup proposal in the legacy YAML path never changes it.
 * Only the repositories section (the thing setup exists to discover) is open.
 */
export const SECTION_PROTECTED: Readonly<Record<ManifestSection, boolean>> = {
  general: true,
  git: true,
  services: false,
  approaches: true,
  agents: true,
  ticketing: true,
  quality: true,
  autopilot: true,
  project: true,
};

/** The top-level manifest keys of one section, derived from `SECTION_OF`. */
export function keysOfSection(section: ManifestSection): readonly (keyof Manifest)[] {
  return (Object.keys(SECTION_OF) as (keyof Manifest)[]).filter((k) => SECTION_OF[k] === section);
}

/** Every protected top-level key, derived from the two tables. */
export function protectedKeys(): readonly (keyof Manifest)[] {
  return (Object.keys(SECTION_OF) as (keyof Manifest)[]).filter((k) => SECTION_PROTECTED[SECTION_OF[k]]);
}
