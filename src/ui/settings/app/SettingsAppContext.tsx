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
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Manifest } from '../../../manifest/types.js';
import {
  SECTION_FIELDS,
  SECTION_LABELS,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from '../sections.js';
import type { SettingsHostMessage } from '../messages.js';
import { overlaySections } from './draft.js';
import {
  INITIAL_SETTINGS_APP_STATE,
  beginSave,
  clearUndo,
  discardWithUndo,
  invalidateTicketFetchesFor,
  setDraftManifest,
  settingsAppReducer,
  touchField,
  undoDiscard,
  type SettingsAppState,
} from './reducer.js';
import {
  firstSectionWithLocalError,
  hasInlineFieldFault,
  localFieldErrors,
  manifestFaultDetail,
  sectionForError,
  shouldShowBanner,
} from './diagnostics.js';
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
  | { readonly kind: 'discard'; readonly section: SettingsSection }
  | { readonly kind: 'undo-discard' }
  | { readonly kind: 'clear-undo' };

function appReducer(state: SettingsAppState, action: AppAction): SettingsAppState {
  switch (action.kind) {
    case 'host':
      return settingsAppReducer(state, action.message);
    case 'edit': {
      const next = setDraftManifest(state, action.update(state.draft));
      // A ticketing edit can move the key a cached fetch belongs to, and the
      // reducer owns the fetches — so the invalidation is its decision, not a
      // component's (R-X4).
      return invalidateTicketFetchesFor(state, next);
    }
    case 'touch':
      return touchField(state, action.key);
    case 'begin-save':
      return beginSave(state, action.section);
    case 'discard':
      return discardWithUndo(state, action.section);
    case 'undo-discard':
      return undoDiscard(state);
    case 'clear-undo':
      return clearUndo(state);
    default:
      return state;
  }
}

/**
 * A section's own gate on a Settings-section switch. Called with the switch it
 * would perform: return `true` to block it, and call `proceed` later (after
 * Save or Discard) when the switch may run. A section registers one while it
 * holds edits that live outside the manifest draft — the profile buffers on the
 * Agents page would otherwise be lost with the unmount.
 */
export type LeaveGuard = (proceed: () => void) => boolean;

export interface SettingsApp {
  readonly state: SettingsAppState;
  /** The tab on screen. Owned here so the nav, the shell and the section mount
   *  cannot disagree about what is visible. */
  readonly section: SettingsSection;
  readonly setSection: (target: SettingsSection) => void;
  /** Register the current section's leave guard, or `null` to clear it. */
  readonly setLeaveGuard: (guard: LeaveGuard | null) => void;
  /** Run the registered guard; `true` means it blocked and will call `proceed`. */
  runLeaveGuard(proceed: () => void): boolean;
  readonly send: SettingsHostBridge['send'];
  /** Is `target` holding uncommitted edits? */
  isDirty(target: SettingsSection): boolean;
  /** Is the draft currently valid per the host's last verdict? */
  readonly valid: boolean;
  /** The tab blocking Save (local errors first), or `null` when unattributable. */
  readonly errorSection: SettingsSection | null;
  /** The tab the BANNER's fault belongs to (its prefix and "Go to" link). */
  readonly bannerSection: SettingsSection | null;
  /** The banner text, or `null` when no banner should be visible. */
  readonly bannerText: string | null;
  /** Field errors the Quality editors already know about, per tab (SET-4/12). */
  readonly localErrors: Partial<Record<SettingsSection, number>>;
  /** Total local field errors across tabs — the shell's "Fix N fields" count. */
  readonly localErrorCount: number;
  /**
   * True while the Agents › Accounts tab is on screen (Q4-SAVE): its controls
   * save immediately, so the shell hides Save and Discard.
   */
  readonly instantApply: boolean;
  readonly setInstantApply: (on: boolean) => void;
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
  /** Put back the draft a Discard replaced (Q11). */
  undoDiscard(): void;
  /** Forget a pending Undo without restoring it (timer, Save, section switch). */
  clearUndo(): void;
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
  const host = useMemo(() => bridge ?? pageHostBridge(), [bridge]);
  const [state, dispatch] = useReducer(
    appReducer,
    INITIAL_SETTINGS_APP_STATE,
    (base) => {
      const persisted = host.getState();
      if (
        persisted?.manifest &&
        typeof persisted.manifest === 'object' &&
        'host' in (persisted.manifest as Record<string, unknown>)
      ) {
        const manifest = persisted.manifest as Manifest;
        return {
          ...base,
          draft: manifest,
          lastSaved: manifest,
          tokenConfigured: !!persisted.tokenConfigured,
        };
      }
      return base;
    },
  );
  const [section, setSectionState] = useState<SettingsSection>(initialSection ?? FIRST_SECTION);
  // Q4-SAVE: only the Accounts tab applies at once. Owned here so the shell and
  // the section cannot disagree; leaving the tab (or Agents) resets it. Entering
  // it also ends a pending Discard/Undo: the Undo banner's controls are hidden
  // there, and restoring the hidden Roles/Sandbox draft would be invisible and
  // would drop focus on the unmounted Discard button (Q11).
  const [instantApply, setInstantApplyState] = useState(false);
  const setInstantApply = useCallback((on: boolean) => {
    setInstantApplyState(on);
    if (on) dispatch({ kind: 'clear-undo' });
  }, []);
  const setSection = useCallback((target: SettingsSection) => {
    setSectionState(target);
    // Q11: an Undo belongs to the tab that was discarded, and a switch is a
    // deliberate move on — restoring another tab's old draft would be a surprise.
    dispatch({ kind: 'clear-undo' });
    setInstantApplyState(false);
  }, []);
  const { send } = host;

  // The mounted section's leave guard. A ref, not state: registering a guard
  // must not re-render the app, and the guard is read at switch time.
  const leaveGuard = useRef<LeaveGuard | null>(null);
  const setLeaveGuard = useCallback((guard: LeaveGuard | null) => {
    leaveGuard.current = guard;
  }, []);
  const runLeaveGuard = useCallback(
    (proceed: () => void) => leaveGuard.current?.(proceed) ?? false,
    [],
  );

  // The message listener is external sync — the one effect the boundary owns.
  // Every host message goes through the pure reducer; nothing here interprets a
  // message's payload beyond handing it over.
  useEffect(
    () => host.subscribe((message) => {
      if (message.type === 'navigate') {
        // A host deep link: the hash first (the Agents page reads it on mount and on hashchange), then the tab.
        try {
          window.location.hash = message.hash;
        } catch {
          /* hash unavailable — the section still switches */
        }
        if (message.hash.startsWith('#agents')) setSection('agents');
      }
      dispatch({ kind: 'host', message });
    }),
    [host, setSection],
  );

  // Persist across a reload: the manifest the file holds, plus the token flag
  // (keychain state, re-reported by the host — kept so the tab does not flash
  // "No token" while the first `state` push is in flight). Only write after hydration
  // so the empty placeholder never clobbers persisted state.
  const { lastSaved, tokenConfigured, hydrated } = state;
  useEffect(() => {
    if (!hydrated) return;
    host.setState({ manifest: lastSaved, tokenConfigured });
  }, [host, lastSaved, tokenConfigured, hydrated]);

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
  const undoDiscardAction = useCallback(() => dispatch({ kind: 'undo-discard' }), []);
  const clearUndoAction = useCallback(() => dispatch({ kind: 'clear-undo' }), []);

  // The tab's to-be-saved manifest: its own draft fields over the saved
  // baseline, exactly what `save` would merge for this section.
  const saveCandidate = useCallback(
    (target: SettingsSection) => overlaySections(state.lastSaved, state.draft, [target]),
    [state.lastSaved, state.draft],
  );

  // Derived in render (R-X4). The fault is the draft's verdict first and the
  // host-reported failure second, so a rejected save and a rejected draft both
  // point at a tab.
  const fault = state.validation.ok ? state.hostError : state.validation.error;
  // @arch:SAVE: validate the per-tab CANDIDATE, never the raw draft — an
  // unfinished edit parked on another tab cannot block this one's Save, and a
  // local count can only ever belong to the section it is shown on.
  const localErrors = useMemo(
    () => localFieldErrors(saveCandidate(section)),
    [saveCandidate, section],
  );
  const localErrorCount = useMemo(
    () => Object.values(localErrors).reduce((sum, n) => sum + (n ?? 0), 0),
    [localErrors],
  );
  // The host has only ever reported ONE fault. A local field error on the
  // shown tab comes FIRST: it is what blocks this tab's Save and what the user
  // can fix right now, so a host message naming another tab must not steal the
  // attribution (it used to render the blocking Quality errors as "Unsaved
  // changes"). With no local error, the host fault (verdict or action error)
  // still names its tab and marks the nav as before.
  const localErrorSection = useMemo(
    () => firstSectionWithLocalError(localErrors, SETTINGS_SECTIONS),
    [localErrors],
  );
  const errorSection = useMemo(
    () => localErrorSection ?? sectionForError(fault),
    [localErrorSection, fault],
  );
  // A fault belonging to a DIFFERENT tab is prefixed with that tab's label, so
  // the banner says whose problem it is. Standing ON the owning tab, the message
  // is shown verbatim — the prefix would only be noise.
  // The banner and its "Go to" link must agree on ONE owner: `bannerSection`,
  // not `errorSection` (which prefers the shown tab's local errors for Save).
  const bannerSection = useMemo(() => sectionForError(fault), [fault]);
  const bannerText = useMemo(() => {
    if (!shouldShowBanner(fault, state.touched)) return null;
    // SET-6 / UI-R25: a fault the section already renders under its own control
    // is not repeated in the top banner.
    if (hasInlineFieldFault(fault, section)) return null;
    const detail = manifestFaultDetail(fault);
    if (!detail) return null;
    return bannerSection && bannerSection !== section
      ? `${SECTION_LABELS[bannerSection]}: ${detail}`
      : detail;
  }, [fault, state.touched, section, bannerSection]);

  const isDirty = useCallback(
    (target: SettingsSection) => state.dirtySections.includes(target),
    [state.dirtySections],
  );

  const value = useMemo<SettingsApp & SettingsAppActions>(
    () => ({
      state,
      section,
      setSection,
      setLeaveGuard,
      runLeaveGuard,
      send,
      isDirty,
      valid: state.validation.ok && localErrorCount === 0,
      errorSection,
      bannerSection,
      bannerText,
      localErrors,
      localErrorCount,
      instantApply,
      setInstantApply,
      saveCandidate,
      edit,
      touch,
      markSaveStarted,
      discard,
      undoDiscard: undoDiscardAction,
      clearUndo: clearUndoAction,
    }),
    [
      state,
      section,
      setSection,
      setLeaveGuard,
      runLeaveGuard,
      send,
      isDirty,
      errorSection,
      bannerSection,
      bannerText,
      localErrors,
      localErrorCount,
      instantApply,
      setInstantApply,
      saveCandidate,
      edit,
      touch,
      markSaveStarted,
      discard,
      undoDiscardAction,
      clearUndoAction,
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
