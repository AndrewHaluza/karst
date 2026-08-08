import type { Manifest } from '../../manifest/types.js';

/**
 * The settings page's tabs, and the manifest fields each one owns.
 *
 * Save is TAB-SCOPED: pressing Save on General writes General's fields onto the
 * manifest CURRENTLY ON DISK and leaves every other section exactly as the file
 * has it. A whole-draft save was the old behavior and it is what made Save read
 * as "unnatural" — an edit half-made on one tab (or an approach drawer save,
 * which posts the same whole draft) silently committed unrelated in-progress
 * edits from every other tab.
 *
 * Merging onto the file rather than onto the webview's baseline also means the
 * out-of-band writers — `setAgentEnabled`, `setApproachEnabled`, the approach
 * drawer — cannot be clobbered by a stale draft that was loaded before they ran.
 *
 * Fields no section claims (`id`) are never editable here and always survive
 * from the base. The Quality tab claims `uat`/`review` but renders only the
 * keys with live consumers, so its editors MUST spread the existing block
 * rather than rebuild it — see docs/config-ui-coverage.md, D1/D3.
 */
export const SETTINGS_SECTIONS = [
  'general',
  'git',
  'services',
  'approaches',
  'agents',
  'ticketing',
  'quality',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Tab labels, as the nav renders them — used in Save/confirm copy. */
export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  git: 'Git',
  services: 'Repositories',
  approaches: 'Approaches',
  agents: 'Agents',
  ticketing: 'Ticketing',
  quality: 'Quality',
};

export const SECTION_FIELDS: Record<SettingsSection, readonly (keyof Manifest)[]> = {
  general: [
    'host',
    'portRange',
    'baselineBranch',
    'worktreePathDisplay',
    'ticketLabelTemplate',
    'terminalNameTemplate',
    'agentProvider',
    'defaultModel',
  ],
  git: ['conventions'],
  services: ['repositories'],
  approaches: ['approaches'],
  agents: ['agents', 'processes'],
  ticketing: ['ticketing'],
  quality: ['uat', 'review'],
};

export function isSettingsSection(value: unknown): value is SettingsSection {
  return (
    typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value)
  );
}

/**
 * `base` with only `section`'s fields taken from `incoming`. A field absent from
 * `incoming` is REMOVED (that is how the webview clears an optional template),
 * so this is an overlay of the section, never a spread of defined values.
 */
export function mergeSection(
  base: Manifest,
  incoming: Manifest,
  section: SettingsSection,
): Manifest {
  const merged: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  const source = incoming as unknown as Record<string, unknown>;
  for (const field of SECTION_FIELDS[section]) {
    if (Object.prototype.hasOwnProperty.call(source, field)) merged[field] = source[field];
    else delete merged[field];
  }
  return merged as unknown as Manifest;
}
