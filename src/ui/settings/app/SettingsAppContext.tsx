/**
 * The settings app's state container: the ONE place `settingsAppReducer` is
 * driven, and the ONLY bridge from a section's controls to the host (NDL-126
 * §3, R-X7).
 *
 * Three rules this file exists to hold:
 *
 * - **One store.** Sections read `state` and call `edit()`; they never hold a
 *   second copy of the manifest, because a second copy is how dirty markers
 *   start disagreeing with the file (`draft.ts`).
 * - **No derived state in effects.** `errorSection`, `bannerText` and
 *   `saveCandidate` are computed in render / `useMemo`, so they cannot lag a
 *   message by a frame (R-X4).
 * - **The host owns async lifecycle.** The only `useEffect` here is the message
 *   subscription — external sync. Anything a section does that waits on the host
 *   goes through `useHostMutation` (R11–R15, R17, R18).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import type { Manifest } from '../../../manifest/types.js';
import { SECTION_FIELDS, SECTION_LABELS, type SettingsSection } from '../sections.js';
import type { SettingsHostMessage } from '../messages.js';
import { overlaySections } from './draft.js';
import {
  INITIAL_SETTINGS_APP_STATE,
  beginSave,
  setDraftManifest,
  settingsAppReducer,
  touchField,
  type SettingsAppState,
} from './reducer.js';
import { manifestFaultDetail, sectionForError, shouldShowBanner } from './diagnostics.js';
import { pageHostBridge, type SettingsHostBridge } from './hostBridge.js';

/**
 * The store's action union: a host push, or a local edit.
 *
 * The local cases are not folded into `settingsAppReducer` on purpose — that
 * switch is `reducer(state, HostMessage)`, the host→webview direction only, and
 * a field edit has no host message. `appReducer` below routes both into the same
 * state, so there is still exactly one store (R-X7).
 */
type AppAction =
  | { readonly kind: 'host'; readonly message: SettingsHostMessage }
  | { readonly kind: 'edit'; readonly update: (draft: Manifest) => Manifest }
  | { readonly kind: 'touch'; readonly key: string }
  | { readonly kind: 'begin-save'; readonly section: SettingsSection }
  | { readonly kind: 'discard'; readonly section: SettingsSection };

function appReducer(state: SettingsAppState, action: AppAction): SettingsAppState {
  switch (action.kind) {
    case 'host':
      return settingsAppReducer(state, action.message);
    case 'edit':
      return setDraftManifest(state, action.update(state.draft));
    case 'touch':
      return touchField(state, action.key);
    case 'begin-save':
      return beginSave(state, action.section);
    case 'discard':
      return setDraftManifest(state, overlaySections(state.draft, state.lastSaved, [action.section]));
    default:
      return state;
  }
}

export interface SettingsApp {
  readonly state: SettingsAppState;
  /** The tab on screen. Owned here so the nav, the shell and the section mount
   *  cannot disagree about what is visible. */
  readonly section: SettingsSection;
  readonly setSection: (target: SettingsSection) => void;
  readonly send: SettingsHostBridge['send'];
  /** Is `target` holding uncommitted edits? */
  isDirty(target: SettingsSection): boolean;
  /** Is the draft currently valid per the host's last verdict? */
  readonly valid: boolean;
  /** The tab a validation fault belongs to, or `null` when unattributable. */
  readonly errorSection: SettingsSection | null;
  /** The banner text, or `null` when no banner should be visible. */
  readonly bannerText: string | null;
  /**
   * Exactly what a Save on `target` would write: the baseline with that tab's
   * edits. Also what the debounced `validate` posts, so a half-finished edit
   * parked on another tab can never block this one.
   */
  saveCandidate(target: SettingsSection): Manifest;
}

export interface SettingsAppActions {
  /** Apply a local edit to the draft. The updater returns the NEW manifest. */
  edit(update: (draft: Manifest) => Manifest): void;
  /** Mark `name.fieldPath` touched, so a mapped error may show on it. */
  touch(key: string): void;
  /** Note that a Save of `target` is being requested. */
  markSaveStarted(target: SettingsSection): void;
  /** Roll one tab's fields back to the baseline; other tabs' edits survive. */
  discard(target: SettingsSection): void;
}

const AppContext = createContext<(SettingsApp & SettingsAppActions) | null>(null);

/** The tab shown on open — the first section in nav order, as the vanilla view. */
const FIRST_SECTION: SettingsSection = 'general';

export interface SettingsAppProviderProps {
  readonly bridge?: SettingsHostBridge;
  /** The tab shown first; defaults to the first section in nav order. */
  readonly initialSection?: SettingsSection;
  readonly children: ReactNode;
}

export function SettingsAppProvider({
  bridge,
  initialSection,
  children,
}: SettingsAppProviderProps) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_SETTINGS_APP_STATE);
  const [section, setSection] = useState<SettingsSection>(initialSection ?? FIRST_SECTION);
  const host = useMemo(() => bridge ?? pageHostBridge(), [bridge]);
  const { send } = host;

  // The message listener is external sync — the one effect the boundary owns.
  // Every host message goes through the pure reducer; nothing here interprets a
  // message's payload beyond handing it over.
  useEffect(
    () => host.subscribe((message) => dispatch({ kind: 'host', message })),
    [host],
  );

  // Persist across a reload: the manifest the file holds, plus the token flag
  // (keychain state, re-reported by the host — kept so the tab does not flash
  // "No token" while the first `state` push is in flight).
  const { lastSaved, tokenConfigured } = state;
  useEffect(
    () => host.setState({ manifest: lastSaved, tokenConfigured }),
    [host, lastSaved, tokenConfigured],
  );

  const edit = useCallback(
    (update: (draft: Manifest) => Manifest) => dispatch({ kind: 'edit', update }),
    [],
  );
  const touch = useCallback((key: string) => dispatch({ kind: 'touch', key }), []);
  const markSaveStarted = useCallback(
    (target: SettingsSection) => dispatch({ kind: 'begin-save', section: target }),
    [],
  );
  const discard = useCallback(
    (target: SettingsSection) => dispatch({ kind: 'discard', section: target }),
    [],
  );

  // Derived in render (R-X4). The fault is the draft's verdict first and the
  // host-reported failure second, so a rejected save and a rejected draft both
  // point at a tab.
  const fault = state.validation.ok ? state.hostError : state.validation.error;
  const errorSection = useMemo(() => sectionForError(fault), [fault]);
  // A fault belonging to a DIFFERENT tab is prefixed with that tab's label, so
  // the banner says whose problem it is. Standing ON the owning tab, the message
  // is shown verbatim — the prefix would only be noise.
  const bannerText = useMemo(() => {
    if (!shouldShowBanner(fault, state.touched)) return null;
    const detail = manifestFaultDetail(fault);
    if (!detail) return null;
    const owner = sectionForError(fault);
    return owner && owner !== section ? `${SECTION_LABELS[owner]}: ${detail}` : detail;
  }, [fault, state.touched, section]);

  const isDirty = useCallback(
    (target: SettingsSection) => state.dirtySections.includes(target),
    [state.dirtySections],
  );

  const saveCandidate = useCallback(
    (target: SettingsSection) => overlaySections(state.lastSaved, state.draft, [target]),
    [state.lastSaved, state.draft],
  );

  const value = useMemo<SettingsApp & SettingsAppActions>(
    () => ({
      state,
      section,
      setSection,
      send,
      isDirty,
      valid: state.validation.ok,
      errorSection,
      bannerText,
      saveCandidate,
      edit,
      touch,
      markSaveStarted,
      discard,
    }),
    [
      state,
      section,
      send,
      isDirty,
      errorSection,
      bannerText,
      saveCandidate,
      edit,
      touch,
      markSaveStarted,
      discard,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** The nearest settings app. Throws rather than silently no-op'ing outside one. */
export function useSettingsApp(): SettingsApp & SettingsAppActions {
  const app = useContext(AppContext);
  if (!app) throw new Error('useSettingsApp must be used inside <SettingsAppProvider>');
  return app;
}

/**
 * The per-tab editable value, defaulted the way the host's validator defaults
 * it. Sections render `value ?? fallback` so a manifest that omits a key shows
 * what ship would use rather than an empty control.
 */
export function readField<T>(manifest: Manifest, key: keyof Manifest, fallback: T): T {
  const value = manifest[key];
  return (value === undefined ? fallback : value) as T;
}

/** Whether a field belongs to `section` — anything else is never editable here. */
export function ownsField(section: SettingsSection, field: keyof Manifest): boolean {
  return SECTION_FIELDS[section].some((owned) => owned === field);
}
