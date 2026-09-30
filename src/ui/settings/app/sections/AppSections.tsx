/**
 * The section mount: the ported settings tabs, one at a time (NDL-126 §8).
 *
 * Phase 1 landed this container with no sections, because the vanilla script was
 * still the live implementation and rendering nothing was correct. Phase 3
 * step 2 fills it in — General, Git, Quality, Ticketing first: the low-coupling
 * tabs that establish the section-mount pattern, the Save wiring through
 * `useHostMutation`, and the dirty-marker / nav-dot plumbing against the real
 * reducer. Repositories, Approaches, Agents and Presets follow.
 *
 * A section that is not ported yet renders nothing rather than a placeholder: an
 * empty tab is honest about what the React view can do, and the nav still marks
 * it, so the shell's dirty/error markers stay correct for tabs whose editors are
 * still vanilla.
 *
 * Mounting is by CURRENT SECTION, not all-at-once — the tab on screen is the
 * only one whose controls can hold focus or an open menu, and it keeps every
 * section's state in the one reducer rather than in per-tab components.
 */
import type { ReactElement } from 'react';
import type { SettingsSection } from '../../sections.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { GeneralSection } from './GeneralSection.js';

const PORTED: Readonly<Partial<Record<SettingsSection, () => ReactElement>>> = {
  general: GeneralSection,
};

/** The current tab's editor, or nothing while its tab is still vanilla. */
export function AppSections() {
  const { section } = useSettingsApp();
  const Section = PORTED[section];
  return <div data-karst-settings-app="true">{Section ? <Section /> : null}</div>;
}
