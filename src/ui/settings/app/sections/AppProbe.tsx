/**
 * A test probe for the settings app's derived state.
 *
 * The app keeps ONE store, so a test that wants to assert on a draft, a dirty
 * marker or a banner needs to read that store rather than infer it. Serialising
 * it onto one element is the honest way: it is the reducer's actual output, read
 * back out of the DOM, instead of a second implementation of the same rules in
 * the test.
 *
 * It ships as a component (not a test file) so both the COMPONENT tests and the
 * rendered-Settings tests can import it, and so `architecture.test.ts` keeps
 * policing it like any other app source.
 */
import { useSettingsApp } from '../SettingsAppContext.js';

export interface AppProbeShape {
  readonly section: string;
  readonly draft: unknown;
  readonly lastSaved: unknown;
  readonly dirtySections: readonly string[];
  readonly valid: boolean;
  readonly errorSection: string | null;
  readonly bannerText: string | null;
  readonly pendingSaveSection: string | null;
  readonly hydrated: boolean;
}

/** Serialises the app's derived state onto one element, for assertions. */
export function AppProbe() {
  const { state, section, errorSection, bannerText } = useSettingsApp();
  const shape: AppProbeShape = {
    section,
    draft: state.draft,
    lastSaved: state.lastSaved,
    dirtySections: state.dirtySections,
    valid: state.validation.ok,
    errorSection,
    bannerText,
    pendingSaveSection: state.pendingSaveSection,
    hydrated: state.hydrated,
  };
  return <span hidden data-probe="app" data-state={JSON.stringify(shape)} />;
}

/** Read the probe out of a rendered tree (or the jsdom document). */
export function readProbe(root: ParentNode = document): AppProbeShape {
  const node = root.querySelector('[data-probe="app"]');
  const raw = node?.getAttribute('data-state');
  if (!raw) throw new Error('AppProbe is not mounted');
  return JSON.parse(raw) as AppProbeShape;
}
