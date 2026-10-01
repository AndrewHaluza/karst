/**
 * The Ticketing tab (NDL-126 §8.3, phase 3 step 2).
 *
 * `SECTION_FIELDS.ticketing` is one block, and this is the only tab with an async
 * lifecycle of its own: the ClickUp list and status fetches. Three rules decide
 * where each piece of that lives:
 *
 * - **The reducer owns the data and the coherence rule.** `state.statuses` and
 *   `state.lists` carry `idle` / `loading` / `ready` / `failed`, and
 *   `applyTicketStatuses` is what fills an unset `shipStatus` with the list's
 *   first entry and an unset `startStatus` with the one named "in progress". The
 *   component does NOT re-derive any of that (R-X4) — it renders what the
 *   reducer decided.
 * - **The hook owns the pending window.** `useHostMutation` is the only owner of
 *   async lifecycle (R11–R15, R17, R18), so `loading` is the hook's own status,
 *   not a second piece of state this file keeps.
 * - **The hint copy is the vanilla copy.** Every string under the reload buttons
 *   — "Loading lists…", "Add a Team ID and API token to load lists.", "This list
 *   has no statuses.", `"X" is no longer in this list.` — is ported verbatim,
 *   because those lines are what tell a user which prerequisite is missing.
 *
 * A saved list or status the provider no longer offers is kept VISIBLE and
 * selected, never silently dropped: dropping it would save an empty value away
 * and quietly un-configure a working board.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Manifest, TicketingConfig } from '../../../../manifest/types.js';
import {
  TICKET_PROVIDER_IDS,
  providerLabel,
} from '../../../../model/ticketProviders.js';
import type { TicketList } from '../../../../integrations/ticketing.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation, type MutationStatus } from '../useHostMutation.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { Help } from '../primitives/Help.js';
import type { ListFetch, StatusFetch } from '../reducer.js';
import { ProviderBadgeIsland } from './ProviderBadgeIsland.js';

/** A hint line's copy, in the vanilla wording. */
const HINT = {
  listsPrereqs: 'Add a Team ID and API token to load lists.',
  statusesPrereqs: 'Add a List ID and API token to load statuses.',
  loadingLists: 'Loading lists…',
  loadingStatuses: 'Loading statuses…',
  noLists: 'This workspace has no lists.',
  noStatuses: 'This list has no statuses.',
  placeholderList: '— select a list —',
  staleList: (saved: string) => `"${saved}" is no longer in this workspace.`,
  staleStatus: (saved: string) => `"${saved}" is no longer in this list.`,
} as const;

const isClickup = (provider: string | undefined): boolean => provider === 'clickup';

/** Read the block, or an empty one — a manifest may declare no `ticketing` at all. */
const ticketingOf = (draft: Manifest): TicketingConfig =>
  draft.ticketing ?? ({ provider: 'manual' } as TicketingConfig);

export function TicketingSection() {
  const { state, send, edit } = useSettingsApp();
  const cfg = ticketingOf(state.draft);
  const tokenConfigured = state.tokenConfigured;

  const lists = useHostMutation<[string]>({
    kind: 'Load lists',
    send: (requestId, teamId) => send.fetchTicketLists(teamId, requestId),
  });
  const statuses = useHostMutation<[string, string | undefined]>({
    kind: 'Load statuses',
    // Two buttons drive ONE fetch; whichever is on screen gets the spinner and a
    // single request id settles it.
    send: (requestId, listId, teamId) => send.fetchTicketStatuses(listId, teamId, requestId),
  });

  // Settle each fetch from the reducer's view of its reply, so there is ONE
  // direction of truth for the data and the hook only mirrors the lifecycle.
  const listState = state.lists;
  const statusState = state.statuses;
  useEffect(() => {
    if (listState.kind === 'ready') lists.settle({ requestId: current(lists.requestId), result: 'success' });
    if (listState.kind === 'failed') {
      lists.settle({ requestId: current(lists.requestId), result: 'failure', message: listState.error });
    }
  }, [listState, lists]);

  useEffect(() => {
    if (statusState.kind === 'ready') {
      statuses.settle({ requestId: current(statuses.requestId), result: 'success' });
    }
    if (statusState.kind === 'failed') {
      statuses.settle({
        requestId: current(statuses.requestId),
        result: 'failure',
        message: statusState.error,
      });
    }
  }, [statusState, statuses]);

  const listPrereqsMet = Boolean(cfg.teamId) && tokenConfigured;
  const statusPrereqsMet = Boolean(cfg.listId) && tokenConfigured;
  const providerIsClickup = isClickup(cfg.provider);

  // The auto-fetch is armed once per session and re-armed by a team-id edit, so
  // opening the tab twice does not refetch, but fixing a prerequisite does. A ref
  // because it gates an effect rather than rendering anything.
  const listsRequested = useRef(false);
  useEffect(() => {
    if (!providerIsClickup || listsRequested.current || !listPrereqsMet) return;
    listsRequested.current = true;
    lists.trigger(cfg.teamId as string);
  }, [providerIsClickup, listPrereqsMet, cfg.teamId, lists]);

  const requestLists = useCallback(() => {
    if (!listPrereqsMet) return;
    listsRequested.current = true;
    lists.trigger(cfg.teamId as string);
  }, [listPrereqsMet, cfg.teamId, lists]);

  const requestStatuses = useCallback(() => {
    if (!statusPrereqsMet) return;
    statuses.trigger(cfg.listId as string, cfg.teamId);
  }, [statusPrereqsMet, cfg.listId, cfg.teamId, statuses]);

  const setCfg = useCallback(
    (patch: Partial<TicketingConfig>) => edit((draft) => ({ ...draft, ticketing: { ...ticketingOf(draft), ...patch } })),
    [edit],
  );

  const pickProvider = (id: string): void => {
    const provider = id as TicketingConfig['provider'];
    if (provider === cfg.provider) return;
    // Leaving ClickUp clears everything only ClickUp means: a manual board has no
    // workspace, no list, and no statuses to advance.
    if (provider !== 'clickup') {
      edit((draft) => {
        const next = ticketingOf(draft);
        const cleared: TicketingConfig = { ...next, provider };
        cleared.advanceOnShip = false;
        delete cleared.shipStatus;
        cleared.advanceOnStart = false;
        delete cleared.startStatus;
        delete cleared.searchEnabled;
        return { ...draft, ticketing: cleared };
      });
      return;
    }
    setCfg({ provider });
  };

  const listView = deriveLists(listState, lists.status, cfg.listId, listPrereqsMet);
  const statusView = deriveStatuses(
    statusState,
    statuses.status,
    cfg.shipStatus,
    statusPrereqsMet,
  );

  return (
    <div className="section" id="section-ticketing">
      <div className="page-header">
        <div className="page-title">Ticketing</div>
        <div className="page-desc">
          Connect Karst to the board your tickets live in, and choose the statuses it sets as work
          starts and ships.
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Board connection</div>
            <div className="section-desc">
              Karst creates and advances tickets on the board you name here.
            </div>
          </div>
        </div>

        <ProviderPicker value={cfg.provider} onPick={pickProvider} />

        <div className="section-block" id="clickupFields">
          <div className="field-label" id="teamIdLabel">
            Team ID
          </div>
          <div className="field-control">
            <Field
              label="Team ID"
              help="The ClickUp workspace that owns the list. Needed when task ids are custom."
              control={{
                kind: 'input',
                name: 'teamId',
                value: cfg.teamId ?? '',
                placeholder: 'e.g. 9001',
                onChange: (value) => {
                  const trimmed = value.trim();
                  // Re-arm the list auto-fetch: a new team is a new set of lists.
                  listsRequested.current = false;
                  setCfg(trimmed ? { teamId: trimmed } : { teamId: undefined });
                },
              }}
            />
          </div>

          <div className="field-label" id="listLabel">
            List
          </div>
          <div className="field-control">
            <div className="row">
              <Field
                label="List"
                help="The ClickUp list to advance tickets in."
                control={{
                  kind: 'select',
                  name: 'listId',
                  value: cfg.listId ?? '',
                  disabled: listView.controlDisabled,
                  options: listView.options,
                  onChange: (value) => {
                    // Changing the list invalidates the statuses the previous one
                    // offered; they are re-fetched, never reused across lists.
                    setCfg({ listId: value || undefined });
                    listsRequested.current = true;
                  },
                }}
              />
              <ReloadButton
                label="Reload lists from ClickUp"
                busy={lists.busy}
                disabled={!listPrereqsMet}
                onClick={requestLists}
              />
            </div>
            <Hint role="status">{listView.hint}</Hint>
          </div>

          <div className="field-label" id="tokenLabel">
            API token
          </div>
          <div className="field-control">
            <div className="row">
              <span className={tokenConfigured ? 'status-pill ok' : 'status-pill off'}>
                <span className="dot" />
                <span className="txt">{tokenConfigured ? 'Token set' : 'No token'}</span>
              </span>
              {tokenConfigured ? (
                <ClearTokenButton />
              ) : (
                <SetTokenButton />
              )}
            </div>
            <Help>Stored in your OS keychain — never in karst.yml.</Help>
          </div>
        </div>
      </div>

      {providerIsClickup ? (
        <div className="section-block" id="searchCard">
          <div className="section-title">Ticket search</div>
          <div className="section-desc">
            How the Add/Edit ticket page finds existing tickets instead of typing a key.
          </div>
          <div className="lifecycle-row">
            <div className="lifecycle-copy">
              <Field
                label="Search tickets in the Add/Edit ticket page"
                help="The Key field becomes a dropdown that searches this list's tickets — filtered by status (default: the list's TODO) and sorted by priority."
                control={{
                  kind: 'checkbox',
                  name: 'searchEnabled',
                  // Default ON: only an explicit `false` turns it off.
                  checked: cfg.searchEnabled !== false,
                  onChange: (checked) => setCfg({ searchEnabled: checked }),
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      <div className="section-block" id="advanceCards">
        <div className="section-title">Status updates</div>
        <div className="section-desc">Board statuses Karst sets when work starts and when it ships.</div>

        <div className="lifecycle-row">
          <div className="lifecycle-copy">
            <Field
              label="Set the ticket status when work starts"
              control={{
                kind: 'checkbox',
                name: 'advanceOnStart',
                checked: Boolean(cfg.advanceOnStart),
                onChange: (checked) => setCfg({ advanceOnStart: checked }),
              }}
            />
          </div>
          {cfg.advanceOnStart ? (
            <div className="lifecycle-status" id="startAdvanceStatusRow">
              <div className="row">
                <Field
                  label="Status at start of work"
                  control={{
                    kind: 'select',
                    name: 'startStatus',
                    value: statusView.options.some((o) => o.value === (cfg.startStatus ?? ''))
                      ? (cfg.startStatus ?? '')
                      : (statusView.options[0]?.value ?? ''),
                    disabled: statusView.controlDisabled,
                    options: statusView.options,
                    onChange: (value) =>
                      setCfg({
                        startStatus: value || undefined,
                        advanceOnStart: true,
                      }),
                  }}
                />
                <ReloadButton
                  label="Reload statuses for this list"
                  busy={statuses.busy}
                  disabled={!statusPrereqsMet}
                  onClick={requestStatuses}
                />
              </div>
              <Hint role="status">{statusView.hint}</Hint>
            </div>
          ) : null}
        </div>

        <div className="lifecycle-row">
          <div className="lifecycle-copy">
            <Field
              label="Set the ticket status when karst ships"
              control={{
                kind: 'checkbox',
                name: 'advanceOnShip',
                checked: Boolean(cfg.advanceOnShip),
                onChange: (checked) => setCfg({ advanceOnShip: checked }),
              }}
            />
          </div>
          {cfg.advanceOnShip ? (
            <div className="lifecycle-status" id="advanceStatusRow">
              <div className="row">
                <Field
                  label="Status after ship"
                  control={{
                    kind: 'select',
                    name: 'shipStatus',
                    value: statusView.options.some((o) => o.value === (cfg.shipStatus ?? ''))
                      ? (cfg.shipStatus ?? '')
                      : (statusView.options[0]?.value ?? ''),
                    disabled: statusView.controlDisabled,
                    options: statusView.options,
                    onChange: (value) =>
                      setCfg({ advanceOnShip: Boolean(value), shipStatus: value || undefined }),
                  }}
                />
                <ReloadButton
                  label="Reload statuses for this list"
                  busy={statuses.busy}
                  disabled={!statusPrereqsMet}
                  onClick={requestStatuses}
                />
              </div>
              <Hint role="status">{statusView.hint}</Hint>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function current(requestId: string | undefined): string {
  if (requestId === undefined) throw new Error('no request id to settle');
  return requestId;
}

/** A hint line, or nothing when there is nothing to say. */
function Hint({ role, children }: { role: string; children: string }) {
  if (!children) return null;
  return (
    <span className="field-hint" role={role} aria-live="polite">
      {children}
    </span>
  );
}

interface DerivedLists {
  readonly options: ReadonlyArray<{ value: string; label: string }>;
  readonly controlDisabled: boolean;
  readonly hint: string;
}

/**
 * The list select's options, disabled state and hint — DERIVED in render from
 * `state.lists` plus the fetch's own pending window, never stored (R-X4).
 *
 * The saved list is always present and selected, even before the fetch returns
 * and even after the provider stops offering it, so a half-configured draft can
 * never have its `listId` erased by a repaint.
 */
function deriveLists(
  fetch: ListFetch,
  status: MutationStatus,
  savedId: string | undefined,
  prereqsMet: boolean,
): DerivedLists {
  const loading = status === 'pending';
  if (fetch.kind === 'failed') {
    return { options: savedOption(savedId), controlDisabled: true, hint: fetch.error };
  }
  if (fetch.kind !== 'ready') {
    return {
      options: savedOption(savedId),
      controlDisabled: true,
      hint: loading
        ? HINT.loadingLists
        : prereqsMet
          ? ''
          : HINT.listsPrereqs,
    };
  }
  const lists = fetch.lists;
  const known = savedId !== undefined && lists.some((list) => list.id === savedId);
  const options: Array<{ value: string; label: string }> =
    savedId === undefined
      ? [{ value: '', label: HINT.placeholderList }]
      : savedOption(savedId);
  for (const list of lists) {
    options.push({ value: list.id, label: `${list.space} / ${list.name}` });
  }
  return {
    options,
    controlDisabled: lists.length === 0,
    hint: lists.length === 0
      ? HINT.noLists
      : savedId !== undefined && !known
        ? HINT.staleList(savedId)
        : '',
  };
}

function savedOption(savedId: string | undefined): Array<{ value: string; label: string }> {
  return savedId === undefined ? [] : [{ value: savedId, label: savedId }];
}

/**
 * Both status selects read the SAME derived view — the vanilla view shares one
 * hint string between them — but the alias is kept so a future per-side hint has
 * somewhere to go without changing every call site.
 */
type DerivedStatuses = DerivedLists;

/** The same derivation for the two status selects. */
function deriveStatuses(
  fetch: StatusFetch,
  status: MutationStatus,
  saved: string | undefined,
  prereqsMet: boolean,
): DerivedStatuses {
  const loading = status === 'pending';
  if (fetch.kind === 'failed') {
    return { options: savedOption(saved), controlDisabled: true, hint: fetch.error };
  }
  if (fetch.kind !== 'ready') {
    return {
      options: savedOption(saved),
      controlDisabled: true,
      hint: loading
        ? HINT.loadingStatuses
        : prereqsMet
          ? ''
          : HINT.statusesPrereqs,
    };
  }
  const names = fetch.statuses;
  // A status the provider no longer lists stays visible and selected.
  const stale = saved !== undefined && !names.includes(saved);
  const options = (stale ? [saved, ...names] : names).map((name) => ({
    value: name,
    label: name,
  }));
  return {
    options,
    controlDisabled: names.length === 0,
    hint:
      names.length === 0 ? HINT.noStatuses : stale && saved ? HINT.staleStatus(saved) : '',
  };
}

/**
 * The reload control: a shared `IconButton` whose busy state is the fetch's own
 * `aria-busy` (R11, R26). Its label never changes, so its geometry cannot shift
 * mid-flight (R18); the pending motion is CSS on the icon.
 */
function ReloadButton({
  label,
  busy,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={busy ? 'reload-btn fixed is-pending' : 'reload-btn fixed'}
      title={label}
      aria-label={label}
      aria-busy={busy ? true : undefined}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <span className="k-icon reload-icon" aria-hidden="true">
        ↻
      </span>
    </button>
  );
}

/**
 * The provider listbox.
 *
 * A custom control, not a native `<select>`, for the reason the vanilla view
 * gives: a native select's ACTIVE option foreground is not controllable, so the
 * selected row went unreadable in the light theme (the parity sweep pins the two
 * `.provselect-opt` rules that fix it). `aria-expanded` / `aria-selected` are
 * derived from props, never written imperatively (R26).
 */
function ProviderPicker({
  value,
  onPick,
}: {
  readonly value: string;
  readonly onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="provselect" id="provSelectWrap">
      <div className="field-label" id="ticketProviderLabel">
        Provider
      </div>
      <div className="field-control">
        <button
          type="button"
          className="provselect-trigger"
          id="providerTrigger"
          aria-label="Ticketing provider"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby="ticketProviderLabel"
          onClick={() => setOpen((was) => !was)}
        >
          <ProviderBadgeIsland provider={value} />
          <span className="chev" aria-hidden="true" />
        </button>
        <div
          className={open ? 'provselect-menu' : 'provselect-menu hidden'}
          id="providerMenu"
          role="listbox"
          aria-labelledby="ticketProviderLabel"
        >
          {TICKET_PROVIDER_IDS.map((id) => (
            <div
              key={id}
              className={id === value ? 'provselect-opt selected' : 'provselect-opt'}
              role="option"
              tabIndex={0}
              data-value={id}
              aria-selected={id === value}
              onClick={() => {
                onPick(id);
                close();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  onPick(id);
                  close();
                }
              }}
            >
              <ProviderBadgeIsland provider={id} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** `Set token` — the request the host answers with a `token-state` message. */
function SetTokenButton() {
  const { send, state } = useSettingsApp();
  const token = useHostMutation<void[]>({
    kind: 'Set token',
    send: (requestId) => send.setToken(requestId),
  });
  // The token flag is keychain state, not manifest state: it NEVER touches the
  // draft, because a `state` push would otherwise replace a draft entered during
  // first-time setup — which is where the provider itself is chosen.
  const before = useRef(state.tokenConfigured);
  useEffect(() => {
    if (state.tokenConfigured && !before.current) {
      token.settle({ requestId: current(token.requestId), result: 'success' });
    }
    if (!state.tokenConfigured && before.current) {
      token.settle({ requestId: current(token.requestId), result: 'success' });
    }
    before.current = state.tokenConfigured;
  }, [state.tokenConfigured, token]);

  return (
    <Button variant="secondary" busy={token.busy} onClick={() => token.trigger()}>
      Set token
    </Button>
  );
}

/** `Clear token` — deliberately SECONDARY, not danger (see `messages.ts`). */
function ClearTokenButton() {
  const { send, state } = useSettingsApp();
  const token = useHostMutation<void[]>({
    kind: 'Clear token',
    send: (requestId) => send.clearToken(requestId),
  });
  const before = useRef(state.tokenConfigured);
  useEffect(() => {
    if (before.current !== state.tokenConfigured) {
      token.settle({ requestId: current(token.requestId), result: 'success' });
      before.current = state.tokenConfigured;
    }
  }, [state.tokenConfigured, token]);

  return (
    <Button variant="secondary" busy={token.busy} onClick={() => token.trigger()}>
      Clear token
    </Button>
  );
}

/** Re-exported for the component test's vocabulary assertions (R-X1). */
export { HINT, TICKET_PROVIDER_IDS, providerLabel };
export type { TicketList };
