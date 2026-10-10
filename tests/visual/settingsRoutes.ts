/**
 * The settings routes the layout-sanity gate opens: one per outer section, plus
 * the Agents page's in-page hashes. Derived from SETTINGS_SECTIONS so a new
 * section is covered the moment it exists (settingsRoutes.test.ts pins that).
 */
import { SETTINGS_SECTIONS, type SettingsSection } from '../../src/ui/settings/sections.js';
import { formatAgentsHash } from '../../src/ui/settings/app/sections/agentsRoute.js';
import {
  APPROACH_PROFILE,
  COMPARE_PRESET,
  FIRST_ROLE,
  LONG_BODY_PROFILE,
} from './realisticSettings.js';

export interface LayoutRoute {
  /** Stable id used in reports and the known-failures ledger. */
  readonly id: string;
  readonly section: SettingsSection;
  readonly hash?: string;
}

const AGENTS_HASHES: readonly string[] = [
  formatAgentsHash({ tab: 'roles' }),
  formatAgentsHash({ tab: 'roles', selected: FIRST_ROLE }),
  formatAgentsHash({ tab: 'roles', compare: COMPARE_PRESET }),
  formatAgentsHash({ tab: 'profiles' }),
  formatAgentsHash({ tab: 'profiles', selected: LONG_BODY_PROFILE }),
  formatAgentsHash({ tab: 'profiles', selected: APPROACH_PROFILE }),
  formatAgentsHash({ tab: 'profiles', selected: `builtin:${FIRST_ROLE}` }),
];

export function settingsRoutes(): readonly LayoutRoute[] {
  return SETTINGS_SECTIONS.flatMap((section): LayoutRoute[] =>
    section === 'agents'
      ? AGENTS_HASHES.map((hash) => ({ id: `agents${hash}`, section, hash }))
      : [{ id: section, section }],
  );
}
