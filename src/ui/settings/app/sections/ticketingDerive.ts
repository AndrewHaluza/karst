/**
 * Derivation and copy for the Ticketing tab (T1371).
 *
 * Every string here is user-facing copy from the ticket's spec (the vanilla
 * wording where it existed). The two `derive*` functions turn the reducer's
 * fetch state into a select's options, disabled state and ONE hint line —
 * derived in render, never stored (R-X4).
 *
 * A disabled list or status select ALWAYS carries a hint: the prerequisites,
 * "Loading …", the failure message, the empty-list copy or the stale-value copy
 * (acceptance 5). A hint REPLACES the row's help line, so a user never sees a
 * locked control with no reason next to it.
 */
import type { SyncSubtasksMode } from '../../../../manifest/types.js';
import type { TicketList } from '../../../../integrations/ticketing.js';
import type { ListFetch, StatusFetch } from '../reducer.js';
import type { MutationStatus } from '../useHostMutation.js';

/** A hint line's copy, in the vanilla wording. */
export const HINT = {
  listsPrereqs: 'Add a Team ID and API token to load lists.',
  statusesPrereqs: 'Add a List ID and API token to load statuses.',
  loadingLists: 'Loading lists…',
  loadingStatuses: 'Loading statuses…',
  noLists: 'This workspace has no lists.',
  noStatuses: 'This list has no statuses.',
  placeholderList: '— select a list —',
  dontChange: "Don't change",
  staleList: (saved: string) => `"${saved}" is no longer in this workspace.`,
  staleStatus: (saved: string) => `"${saved}" is no longer in this list.`,
} as const;

/** The page header copy (the prototype's, @ui:UI-R39). */
export const PAGE_DESC = 'Connect Karst to the board your tickets live on.';

export const TEAM_HELP = 'The ClickUp workspace. Karst needs it to load your lists.';
export const LIST_HELP = 'Karst creates and updates tickets in this list.';
export const TOKEN_HELP = 'Kept in your OS keychain, never in karst.yml.';
export const MANUAL_HELP = 'Karst keeps tickets on its own. No board settings.';
export const SEARCH_HELP = 'The Key field searches this list: TODO tickets first, by priority.';
export const START_HELP = 'Karst moves the ticket to this status when the ticket session opens.';
export const SHIP_HELP = 'Karst moves the ticket to this status when the ticket ships.';
export const SUBTASKS_LABEL = 'Sub-tasks on the board';

/** The help line under the sub-task control: only the SELECTED value's meaning. */
export const SUBTASK_HELP: Readonly<Record<SyncSubtasksMode, string>> = {
  off: 'Sub-tasks stay in Karst.',
  link: 'A sub-task is a child task, and a blocking sub-task blocks its parent.',
  full: "Link, plus the sub-task's own status updates.",
};

export interface DerivedSelect {
  readonly options: ReadonlyArray<{ value: string; label: string }>;
  readonly controlDisabled: boolean;
  readonly hint: string;
}

/**
 * The hint for a fetch that has not produced its values yet. The load starts as
 * soon as the prerequisites are met (the auto-load effects), so an idle fetch
 * WITH its prerequisites is "about to load": saying so keeps a disabled select
 * from being unexplained (acceptance 5).
 */
function pendingHint(
  loading: boolean,
  prereqsMet: boolean,
  loadingCopy: string,
  prereqsCopy: string,
): string {
  return loading || prereqsMet ? loadingCopy : prereqsCopy;
}

/**
 * The list select's options, disabled state and hint.
 *
 * The saved list is always present and selected, even before the fetch returns
 * and even after the provider stops offering it, so a half-configured draft can
 * never have its `listId` erased by a repaint.
 */
export function deriveLists(
  fetch: ListFetch,
  status: MutationStatus,
  savedId: string | undefined,
  prereqsMet: boolean,
): DerivedSelect {
  if (fetch.kind === 'failed') {
    return { options: savedOption(savedId), controlDisabled: true, hint: fetch.error };
  }
  if (fetch.kind !== 'ready') {
    return {
      options: savedOption(savedId),
      controlDisabled: true,
      hint: pendingHint(status === 'pending', prereqsMet, HINT.loadingLists, HINT.listsPrereqs),
    };
  }
  const lists = fetch.lists;
  const known = savedId !== undefined && lists.some((list) => list.id === savedId);
  // The saved id gets its own option only when the provider no longer offers
  // it. A list it offers is already one option, with its name as the label.
  const options: Array<{ value: string; label: string }> =
    savedId === undefined
      ? [{ value: '', label: HINT.placeholderList }]
      : known
        ? []
        : savedOption(savedId);
  for (const list of lists) {
    options.push({ value: list.id, label: `${list.space} / ${list.name}` });
  }
  return {
    options,
    controlDisabled: lists.length === 0,
    hint:
      lists.length === 0
        ? HINT.noLists
        : savedId !== undefined && !known
          ? HINT.staleList(savedId)
          : '',
  };
}

function savedOption(savedId: string | undefined): Array<{ value: string; label: string }> {
  return savedId === undefined ? [] : [{ value: savedId, label: savedId }];
}

/** "Don't change" is always the first option; a stale saved value follows it. */
function statusOptions(
  names: readonly string[],
  staleSaved: string | undefined,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [
    { value: '', label: HINT.dontChange },
  ];
  if (staleSaved !== undefined) options.push({ value: staleSaved, label: staleSaved });
  for (const name of names) options.push({ value: name, label: name });
  return options;
}

/**
 * ONE status select's options, disabled state and hint — built from ITS OWN
 * saved value, never a shared view (bug 2: the start select used to show the
 * ship status because both read a view built from `cfg.shipStatus`).
 *
 * A saved status the provider no longer lists stays visible and selected.
 */
export function deriveStatuses(
  fetch: StatusFetch,
  status: MutationStatus,
  saved: string | undefined,
  prereqsMet: boolean,
): DerivedSelect {
  if (fetch.kind === 'failed') {
    return {
      options: statusOptions([], saved),
      controlDisabled: true,
      hint: fetch.error,
    };
  }
  if (fetch.kind !== 'ready') {
    return {
      options: statusOptions([], saved),
      controlDisabled: true,
      hint: pendingHint(status === 'pending', prereqsMet, HINT.loadingStatuses, HINT.statusesPrereqs),
    };
  }
  const names = fetch.statuses;
  const stale = saved !== undefined && !names.includes(saved);
  return {
    options: statusOptions(names, stale ? saved : undefined),
    controlDisabled: names.length === 0,
    hint: names.length === 0 ? HINT.noStatuses : stale && saved ? HINT.staleStatus(saved) : '',
  };
}

/** Re-exported for the component test's vocabulary assertions (R-X1). */
export type { TicketList };
