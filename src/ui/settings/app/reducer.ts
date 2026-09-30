/**
 * The pure half of the settings React app's state (NDL-126 §3).
 *
 * Everything that crosses `postMessage` is a plain JSON value typed by
 * `../messages.js`; everything React owns — hooks, callbacks, component
 * instances — never appears here. That is what makes this module vscode-free,
 * React-free and unit-testable in a plain node environment, and it is why the
 * state can be persisted through `vscode.setState` verbatim without surprises.
 *
 * Shape of the state, and why:
 *
 * - `draft` is the user's editable manifest and `lastSaved` is the file's content
 *   as the host last reported it. Everything about dirty tracking is the
 *   comparison between the two (`draft.ts`), so the two must be stored
 *   separately rather than a single "current manifest".
 * - `host` is the last `state` push, kept VERBATIM. UI-R31: the webview renders
 *   host-computed facts (row labels, preset groups, inherit previews) and
 *   derives none of them, so there is nothing to compute here.
 * - Messages that arrive independently of a `state` push get their own slots
 *   rather than being merged into `host`, because they are refreshes of one
 *   concern, not a new snapshot of everything.
 * - `banner` is NOT stored. It is derived from `validation` + `touched` by
 *   `bannerError()` (see `diagnostics.ts`), so it cannot drift out of step with
 *   the error it is showing.
 *
 * The reducer is total and pure: every `SettingsHostMessage` returns a new state
 * and an unknown message is impossible by construction — the switch is
 * exhaustive and ends in `assertNever`, which is `tsc` as the UI-R16 check
 * (NDL-126 §9.1).
 */
import type { AgentProvider, Manifest } from '../../../manifest/types.js';
import type { ModelCatalog } from '../../../agent/modelCatalog.js';
import type { TicketList } from '../../../integrations/ticketing.js';
import type { SettingsProcessAssignmentView } from '../processAssignmentViews.js';
import type { SettingsSection } from '../sections.js';
import type { SettingsState } from '../state.js';
import type { SettingsHostMessage } from '../messages.js';
import { clone, dirtySectionsOf, overlaySections, sectionsToKeep } from './draft.js';
import { pickDefaultStartStatus } from './diagnostics.js';

/** One terminal `action-result` receipt, keyed by its correlation id (UI-R13). */
export interface ActionReceipt {
  readonly ok: boolean;
  /** `null` when the host reported no prose; never `undefined`, so the receipt
   *  serializes to the same shape it is read back with (UI-R-X2). */
  readonly message: string | null;
}

/** The ticketing status fetch: either the statuses, or why they are missing. */
export type StatusFetch =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly statuses: readonly string[] }
  | { readonly kind: 'failed'; readonly error: string };

/** The ticketing list fetch, same shape. */
export type ListFetch =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly lists: readonly TicketList[] }
  | { readonly kind: 'failed'; readonly error: string };

export interface SettingsAppState {
  /**
   * False until the first `state` push lands. The shell renders nothing but the
   * live region before then — which is also what makes `data-karst-ready` a
   * non-vacuous parity signal: the harness waits on it, so setting it before the
   * app has content would let the sweep pass against an empty view.
   */
  readonly hydrated: boolean;
  readonly draft: Manifest;
  readonly lastSaved: Manifest;
  /** The section a Save is writing; a `state` push drops its edits. */
  readonly pendingSaveSection: SettingsSection | null;
  readonly dirtySections: readonly SettingsSection[];
  /** The last `state` push, verbatim (UI-R31). `null` before the first one. */
  readonly host: SettingsState | null;
  /** A model-catalog refresh (`models`), which arrives without a `state` push. */
  readonly models: {
    readonly models: ModelCatalog;
    readonly modelCompatibility: ModelCatalog;
    readonly recentModels: Readonly<Record<string, string[]>>;
  } | null;
  /** Fresh host-computed inside-process assignment rows. */
  readonly processAssignments: readonly SettingsProcessAssignmentView[] | null;
  /** The draft's validation verdict and the fault that produced it. */
  readonly validation: { readonly ok: boolean; readonly error: string | null };
  /**
   * Field keys the user has actually touched (`name.fieldPath`). A mapped
   * repository error stays silent until its field is touched, so a freshly added
   * repository does not show an error before anyone typed anything.
   */
  readonly touched: readonly string[];
  /** The `error` message — a host-reported failure banner, not a validation fault. */
  readonly hostError: string | null;
  /** The `saved` ack, which says which tab was committed. */
  readonly saved: { readonly section: SettingsSection | null } | null;
  /** A markdown body the drawer is about to open. */
  readonly approachCommandBody: {
    readonly approachId: string;
    readonly command: string;
    readonly body: string;
  } | null;
  readonly tokenConfigured: boolean;
  readonly implementedProviders: readonly AgentProvider[];
  readonly statuses: StatusFetch;
  readonly lists: ListFetch;
  /** Terminal receipts from `action-result`, keyed by correlation id. */
  readonly receipts: Readonly<Record<string, ActionReceipt>>;
}

const EMPTY_DRAFT = {} as unknown as Manifest;

const IDLE_STATUSES: StatusFetch = { kind: 'idle' };
const IDLE_LISTS: ListFetch = { kind: 'idle' };

/** The state the app starts in: no host facts, nothing dirty. */
export const INITIAL_SETTINGS_APP_STATE: SettingsAppState = {
  hydrated: false,
  draft: EMPTY_DRAFT,
  lastSaved: EMPTY_DRAFT,
  pendingSaveSection: null,
  dirtySections: [],
  host: null,
  models: null,
  processAssignments: null,
  validation: { ok: true, error: null },
  touched: [],
  hostError: null,
  saved: null,
  approachCommandBody: null,
  tokenConfigured: false,
  implementedProviders: ['claude'],
  statuses: IDLE_STATUSES,
  lists: IDLE_LISTS,
  receipts: {},
};

/**
 * The default provider set before any `state` push. Matches the script's
 * fallback (`['claude']`) rather than `buildSettingsState`'s wider default: the
 * narrower value is what an un-pushed app has always rendered, and a provider
 * must not look implemented before the host says it is.
 */
const DEFAULT_PROVIDERS: readonly AgentProvider[] = ['claude'];

/** Immutable fact base the host is still the source of truth for. */
function hostFacts(state: SettingsAppState, host: SettingsState): SettingsAppState {
  return {
    ...state,
    host,
    tokenConfigured: state.tokenConfigured || host.tokenConfigured,
    implementedProviders: host.implementedProviders?.length
      ? host.implementedProviders
      : DEFAULT_PROVIDERS,
  };
}

/** Deep-copied `draft`, so no reducer output ever aliases the message payload. */
function replaceDraft(state: SettingsAppState, draft: Manifest): SettingsAppState {
  return {
    ...state,
    draft,
    dirtySections: dirtySectionsOf(draft, state.lastSaved),
  };
}

/**
 * Adopt a `state` push. The draft survives everywhere the user is still dirty,
 * which is the whole point: a push arrives after every out-of-band write (agent
 * toggle, approach install) and replacing the draft would silently throw those
 * edits away.
 */
function applyState(state: SettingsAppState, host: SettingsState): SettingsAppState {
  const incoming = clone(host.manifest);
  const keep = sectionsToKeep(state.draft, state.lastSaved, state.pendingSaveSection);
  const draft = overlaySections(incoming, state.draft, keep);
  const validation = { ok: !host.error, error: host.error };
  return hostFacts(
    {
      ...state,
      hydrated: true,
      draft,
      lastSaved: incoming,
      pendingSaveSection: null,
      dirtySections: dirtySectionsOf(draft, incoming),
      models: {
        models: host.models,
        modelCompatibility: host.modelCompatibility,
        recentModels: host.recentModels,
      },
      processAssignments: host.processAssignments,
      validation,
      // The script cleared the confirm-install latch on every push; the drawer's
      // "Delete" is guarded by "Uninstall before deleting", and a push that
      // re-opens a drawer for an already-uninstalled approach would offer a
      // destructive control for something that is gone.
      approachCommandBody: null,
    },
    host,
  );
}

/**
 * Coherence rule for the ticketing status fetch: statuses arriving with nothing
 * chosen on either side would leave an invalid draft (toggled-on shipping with an
 * empty `shipStatus`), so the common path is made coherent immediately. Ported
 * verbatim from the inline script's `ticket-statuses` case.
 */
function applyTicketStatuses(
  state: SettingsAppState,
  statuses: readonly string[],
): SettingsAppState {
  const ready: StatusFetch = { kind: 'ready', statuses };
  const cfg = state.draft.ticketing;
  if (!cfg) return { ...state, statuses: ready };
  const next = { ...cfg };
  if (!next.shipStatus && statuses.length > 0) next.shipStatus = statuses[0];
  if (!next.startStatus && statuses.length > 0) next.startStatus = pickDefaultStartStatus(statuses);
  // Both are still unset only when the provider returned nothing; in that case
  // there is nothing to make coherent and the draft must not churn.
  if (next.shipStatus === cfg.shipStatus && next.startStatus === cfg.startStatus) {
    return { ...state, statuses: ready };
  }
  return { ...replaceDraft(state, { ...state.draft, ticketing: next }), statuses: ready };
}

/**
 * The folder picker's answer, applied exactly as if the path had been typed —
 * including marking the field touched, because choosing a folder is as
 * deliberate an interaction as typing one. A path for a repository the draft no
 * longer has is dropped rather than resurrecting the repository.
 */
function applyRepoPath(state: SettingsAppState, name: string, path: string): SettingsAppState {
  const repo = state.draft.repositories?.[name];
  if (!repo) return state;
  const next = replaceDraft(state, {
    ...state.draft,
    repositories: {
      ...state.draft.repositories,
      [name]: { ...repo, repoPath: path },
    },
  });
  return { ...next, touched: [...new Set([...state.touched, `${name}.repoPath`])] };
}

/**
 * Exhaustive-switch terminator. `tsc` fails to compile the reducer the moment a
 * new `SettingsHostMessage` variant is added without a case here, which is the
 * UI-R16 closed-discriminant check for a React view (NDL-126 §9.1).
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled settings host message: ${JSON.stringify(value)}`);
}

/**
 * Reduce one host message into the app state. Total, pure, and free of any
 * reference to the message's payload beyond reading it — the payload belongs to
 * the host, so it is cloned rather than aliased.
 */
export function settingsAppReducer(
  state: SettingsAppState,
  message: SettingsHostMessage,
): SettingsAppState {
  switch (message.type) {
    case 'state':
      return applyState(state, message.state);

    case 'models':
      return {
        ...state,
        models: {
          models: message.models,
          modelCompatibility: message.modelCompatibility,
          recentModels: message.recentModels,
        },
      };

    case 'process-assignment-views':
      return { ...state, processAssignments: message.rows };

    case 'validation':
      return { ...state, validation: { ok: message.ok, error: message.ok ? null : message.error } };

    case 'error':
      return { ...state, hostError: message.message };

    case 'saved':
      // The baseline was already re-adopted from the `state` push that precedes
      // this ack, so this only reports what happened.
      return {
        ...state,
        saved: { section: message.section ?? null },
        dirtySections: dirtySectionsOf(state.draft, state.lastSaved),
      };

    case 'approach-command-body':
      return {
        ...state,
        approachCommandBody: {
          approachId: message.approachId,
          command: message.command,
          body: message.body,
        },
      };

    case 'ticket-statuses':
      return applyTicketStatuses(state, message.statuses);

    case 'ticket-statuses-error':
      return { ...state, statuses: { kind: 'failed', error: message.message } };

    case 'ticket-lists':
      return { ...state, lists: { kind: 'ready', lists: message.lists } };

    case 'ticket-lists-error':
      return { ...state, lists: { kind: 'failed', error: message.message } };

    case 'token-state':
      return { ...state, tokenConfigured: message.configured };

    case 'repo-path-picked':
      return applyRepoPath(state, message.name, message.path);

    case 'action-result':
      return {
        ...state,
        receipts: {
          ...state.receipts,
          [message.requestId]: { ok: message.ok, message: message.message ?? null },
        },
      };

    default:
      return assertNever(message);
  }
}

/**
 * The draft after a Save of `section` was requested. Split out because BOTH the
 * user action and the `saved` ack need it, and it must be the same computation
 * in both places or the tab stays dirty forever.
 */
export function beginSave(state: SettingsAppState, section: SettingsSection): SettingsAppState {
  return { ...state, pendingSaveSection: section };
}

/**
 * Replace the draft — the local half of the boundary, a field edit the user just
 * made.
 *
 * Kept beside the reducer rather than inside it: `settingsAppReducer` is
 * `reducer(state, HostMessage)` (NDL-126 §3), the host→webview direction only.
 * A draft edit has no host message, so folding it into the same switch would
 * widen the state boundary with cases that can never arrive from a `postMessage`.
 */
export function setDraftManifest(state: SettingsAppState, draft: Manifest): SettingsAppState {
  return {
    ...state,
    draft: clone(draft),
    dirtySections: dirtySectionsOf(draft, state.lastSaved),
  };
}

/**
 * Drop a ticketing fetch whose KEY the new draft no longer matches.
 *
 * A status list belongs to exactly one `listId`, and a list catalogue to exactly
 * one `teamId`. Once the draft names a different one, the cached answer describes
 * the wrong board — and offering it would let a status belonging to the OLD list
 * be written into the NEW one, which is a silent misconfiguration rather than a
 * visible failure. The host has no message for this because from ITS side nothing
 * happened: only the webview moved the draft, so the invalidation belongs here,
 * next to the fetches it protects.
 *
 * Nothing is dropped when the key did not change, so a status list survives an
 * unrelated edit and the two reload buttons keep working.
 */
export function invalidateTicketFetchesFor(
  before: SettingsAppState,
  after: SettingsAppState,
): SettingsAppState {
  const was = before.draft.ticketing;
  const now = after.draft.ticketing;
  const sameTeam = was?.teamId === now?.teamId;
  const sameList = was?.listId === now?.listId;
  if (sameTeam && sameList) return after;
  // A key that MOVED drops its cache just as hard as one that was cleared: the
  // statuses of list A say nothing about list B, even though both are non-empty.
  const lists: ListFetch = sameTeam ? after.lists : IDLE_LISTS;
  const statuses: StatusFetch = sameList ? after.statuses : IDLE_STATUSES;
  if (lists === after.lists && statuses === after.statuses) return after;
  return { ...after, lists, statuses };
}

/** Record that a field was touched, so a mapped error can be shown on it. */
export function touchField(state: SettingsAppState, key: string): SettingsAppState {
  if (state.touched.includes(key)) return state;
  return { ...state, touched: [...state.touched, key] };
}