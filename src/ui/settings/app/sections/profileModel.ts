/**
 * The Agent profiles tab's list model: local files, approach-provided profiles
 * and the built-in prompt behind each role, each with the roles that use it.
 *
 * A "profile" is the reusable prompt/identity a role is linked to
 * (`processes.<role>.agent`). A role with no profile runs its built-in prompt,
 * so a built-in entry is "used by" exactly the role that has no profile.
 */
import type { Manifest } from '../../../../manifest/types.js';
import { PROMPT_BEARING_PROCESS_KEYS, PROCESS_KEYS, type ProcessKey } from '../../../../manifest/validate/processAssignments.js';
import type { SettingsAgentRow } from '../../state.js';
import { pinKeyOf, rolesUsingProfile } from './rolesModel.js';

export type ProfileGroup = 'local' | 'approach' | 'builtin';

export interface ProfileEntry {
  /** Route id: the profile name, or `builtin:<capability>`. */
  readonly id: string;
  readonly name: string;
  readonly group: ProfileGroup;
  readonly approachId?: string;
  /** "Enable in create flow" — local and approach profiles only. */
  readonly enabled?: boolean;
  /** The profile's text; null when the host could not read it. */
  readonly text: string | null;
  /** Only a local profile's text is editable here. */
  readonly editable: boolean;
  /** The roles that run through this profile (capability ids). */
  readonly usedBy: readonly string[];
  /** Built-in only: the role this prompt belongs to. */
  readonly capability?: string;
  /** Built-in only: does the role's prompt come from a profile body at all? */
  readonly promptBearing?: boolean;
}

export const builtInId = (capability: string): string => `builtin:${capability}`;

export function buildProfileEntries(
  rows: readonly SettingsAgentRow[],
  draft: Manifest,
  roleLabels: Readonly<Record<string, string>>,
  builtInPrompts: Readonly<Record<string, string | null>>,
  capabilities: readonly string[],
): readonly ProfileEntry[] {
  const profiled = rows.map<ProfileEntry>((row) => ({
    id: row.name,
    name: row.name,
    group: row.source === 'file' ? 'local' : 'approach',
    ...(row.approachId === undefined ? {} : { approachId: row.approachId }),
    enabled: row.enabled,
    text: row.body,
    editable: row.source === 'file',
    usedBy: rolesUsingProfile(draft, row.name, capabilities),
  }));
  const builtIn = PROCESS_KEYS.filter((key) => capabilities.includes(key)).map<ProfileEntry>((key) => ({
    id: builtInId(key),
    name: roleLabels[key] ?? key,
    group: 'builtin',
    text: builtInPrompts[key] ?? null,
    editable: false,
    usedBy: draft.processes?.[key]?.agent ? [] : [key],
    capability: key,
    promptBearing: PROMPT_BEARING_PROCESS_KEYS.includes(key as ProcessKey),
  }));
  return [...profiled, ...builtIn];
}

/** Case-insensitive match on the entry's name or its approach id. */
export function filterEntries(entries: readonly ProfileEntry[], query: string): readonly ProfileEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q) || (e.approachId ?? '').toLowerCase().includes(q));
}

/** The list sections in display order; approach profiles group by approach id. */
export function groupEntries(
  entries: readonly ProfileEntry[],
): ReadonlyArray<{ readonly key: string; readonly title: string; readonly entries: readonly ProfileEntry[] }> {
  const groups: Array<{ key: string; title: string; entries: ProfileEntry[] }> = [];
  const add = (key: string, title: string, entry: ProfileEntry): void => {
    const found = groups.find((g) => g.key === key);
    if (found) found.entries.push(entry);
    else groups.push({ key, title, entries: [entry] });
  };
  for (const e of entries.filter((x) => x.group === 'local')) add('local', 'Local (.karst/agents)', e);
  for (const e of entries.filter((x) => x.group === 'approach')) {
    add(`approach:${e.approachId ?? ''}`, `From approach: ${e.approachId ?? ''}`, e);
  }
  for (const e of entries.filter((x) => x.group === 'builtin')) add('builtin', 'Built-in prompts', e);
  return groups;
}

/** A free local profile name for "Customize…": the role's kebab name, then `-custom`, `-custom-2`. */
export function customProfileName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 1;
  let candidate = `${base}-custom`;
  while (taken.has(candidate)) candidate = `${base}-custom-${++n}`;
  return candidate;
}

export { pinKeyOf };
