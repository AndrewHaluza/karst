/**
 * The Ticketing tab (NDL-126 §8.3, T1371/D831).
 *
 * ONE settings list in two sections — Board and Behavior — in the Accounts
 * quota card's row grammar (D829/@ui:UI-R39): a label and one help line at the
 * left, the control in the right-hand column.
 *
 * - **The reducer owns the data and the coherence rule.** `state.statuses` and
 *   `state.lists` carry `idle` / `loading` / `ready` / `failed`, and
 *   `applyTicketStatuses` fills an unset status ONLY for an advance toggle that
 *   is on. The component re-derives none of that (R-X4) — it renders what the
 *   reducer decided.
 * - **The hook owns the pending window.** `useHostMutation` is the only owner of
 *   async lifecycle (R11–R15, R17, R18).
 * - **Both fetches load on their own** (bug 1). The lists were always armed;
 *   the statuses now are too, from an effect like the lists' one: list id and
 *   token set, statuses idle → fetch once, and a list change re-arms it.
 * - **Each status select derives from ITS OWN saved value** (bug 2). The two
 *   selects used to share a view built from `cfg.shipStatus`, so the start
 *   select showed the ship status before the statuses loaded.
 *
 * A saved list or status the provider no longer offers is kept VISIBLE and
 * selected, never silently dropped: dropping it would save an empty value away
 * and quietly un-configure a working board.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Manifest, SyncSubtasksMode, TicketingConfig } from '../../../../manifest/types.js';
import type { TicketList } from '../../../../integrations/ticketing.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import type { ListFetch, StatusFetch } from '../reducer.js';
import type { MutationStatus } from '../useHostMutation.js';
import { TicketingBehavior } from './TicketingBehavior.js';
import { FieldHelp, ProviderPicker, TicketingRow, TokenControl } from './TicketingRows.js';
import {
  HINT,
  LIST_HELP,
  SHIP_HELP,
  START_HELP,
  MANUAL_HELP,
  PAGE_DESC,
  TEAM_HELP,
  TOKEN_HELP,
  deriveLists,
  deriveStatuses,
  type DerivedSelect,
} from './ticketingDerive.js';

const isClickup = (provider: string | undefined): boolean => provider === 'clickup';

/** Read the block, or an empty one — a manifest may declare no `ticketing` at all. */
const ticketingOf = (draft: Manifest): TicketingConfig =>
  draft.ticketing ?? ({ provider: 'manual' } as TicketingConfig);

/** What the connection line under the Board rows says. */
interface Connection {
  readonly ok: boolean;
  readonly text: string;
}

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
    send: (requestId, listId, teamId) => send.fetchTicketStatuses(listId, teamId, requestId),
  });

  // Settle each fetch from the reducer's view of its reply, so there is ONE
  // direction of truth for the data and the hook only mirrors the lifecycle.
  // A settle needs a NEW fetch object: the reducer's state stays `ready` after
  // a reply, so a manual reload (new request id, same `ready` object) must not
  // be settled by the previous reply — it would clear `aria-busy` at once.
  // The seen refs start at the mount-time state: the reducer outlives this
  // component, so after a remount its cached reply is not a reply to a new fetch.
  const listState = state.lists;
  const statusState = state.statuses;
  const seenListState = useRef<ListFetch>(listState);
  const seenStatusState = useRef<StatusFetch>(statusState);
  // A reply for a key the draft has left is dropped by the reducer: the fetch is
  // idle again and no request is recorded. The hook then waits for a reply that
  // never settles it, so it is reset, and the auto-load asks for the new key.
  const listsDropped = listState.kind === 'idle' && state.ticketRequests.lists === null;
  const statusesDropped = statusState.kind === 'idle' && state.ticketRequests.statuses === null;
  useEffect(() => {
    if (lists.requestId === undefined || listState === seenListState.current) return;
    if (listsDropped && lists.pending) {
      seenListState.current = listState;
      lists.reset();
    }
    if (listState.kind === 'ready') {
      seenListState.current = listState;
      lists.settle({ requestId: current(lists.requestId), result: 'success' });
    }
    if (listState.kind === 'failed') {
      seenListState.current = listState;
      lists.settle({ requestId: current(lists.requestId), result: 'failure', message: listState.error });
    }
  }, [listState, listsDropped, lists]);

  useEffect(() => {
    if (statuses.requestId === undefined || statusState === seenStatusState.current) return;
    if (statusesDropped && statuses.pending) {
      seenStatusState.current = statusState;
      statuses.reset();
    }
    if (statusState.kind === 'ready') {
      seenStatusState.current = statusState;
      statuses.settle({ requestId: current(statuses.requestId), result: 'success' });
    }
    if (statusState.kind === 'failed') {
      seenStatusState.current = statusState;
      statuses.settle({
        requestId: current(statuses.requestId),
        result: 'failure',
        message: statusState.error,
      });
    }
  }, [statusState, statusesDropped, statuses]);

  const listPrereqsMet = Boolean(cfg.teamId) && tokenConfigured;
  const statusPrereqsMet = Boolean(cfg.listId) && tokenConfigured;
  const providerIsClickup = isClickup(cfg.provider);

  // The list auto-fetch is armed once per session and re-armed by a team-id
  // edit, so opening the tab twice does not refetch, but fixing a prerequisite
  // does. A ref because it gates an effect rather than rendering anything.
  const listsRequested = useRef(false);
  // Each fetch is marked requested ONLY when its trigger posts. While a fetch is
  // in flight the trigger is a no-op (R12), and a mark then would block the
  // fetch for the new key for good.
  const loadLists = useCallback((): void => {
    if (lists.disabled) return;
    listsRequested.current = true;
    lists.trigger(cfg.teamId as string);
  }, [lists, cfg.teamId]);
  useEffect(() => {
    if (!providerIsClickup || listsRequested.current || !listPrereqsMet) return;
    loadLists();
  }, [providerIsClickup, listPrereqsMet, loadLists]);

  // Bug 1: the statuses load on their own too, once per (list, team) pair. A
  // list change drops the cache to idle (the reducer's decision), which re-arms
  // this; the key keeps a re-render from refetching the same pair.
  const statusKey = `${cfg.listId ?? ''}\u0000${cfg.teamId ?? ''}`;
  const statusesRequested = useRef<string | null>(null);
  const loadStatuses = useCallback((): void => {
    if (statuses.disabled) return;
    statusesRequested.current = statusKey;
    statuses.trigger(cfg.listId as string, cfg.teamId);
  }, [statuses, statusKey, cfg.listId, cfg.teamId]);
  useEffect(() => {
    if (!providerIsClickup || !statusPrereqsMet || statusState.kind !== 'idle') return;
    if (statusesRequested.current === statusKey) return;
    loadStatuses();
  }, [providerIsClickup, statusPrereqsMet, statusState.kind, statusKey, loadStatuses]);

  /** One button in the Board header reloads both fetches (acceptance 6). */
  const reloadAll = useCallback(() => {
    if (listPrereqsMet) loadLists();
    if (statusPrereqsMet) loadStatuses();
  }, [listPrereqsMet, statusPrereqsMet, loadLists, loadStatuses]);

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
        delete cleared.syncSubtasks;
        return { ...draft, ticketing: cleared };
      });
      return;
    }
    setCfg({ provider });
  };

  const listView = deriveLists(listState, lists.status, cfg.listId, listPrereqsMet);
  // A select set to "Don't change" shows no saved status, so it has no stale one.
  const startSaved = cfg.advanceOnStart ? cfg.startStatus : undefined;
  const shipSaved = cfg.advanceOnShip ? cfg.shipStatus : undefined;
  const startView = deriveStatuses(statusState, statuses.status, startSaved, statusPrereqsMet);
  const shipView = deriveStatuses(statusState, statuses.status, shipSaved, statusPrereqsMet);
  const connection = connectionLine(statusState, statuses.status, listView, statusPrereqsMet);

  return (
    <div className="section" id="section-ticketing">
      <div className="page-header">
        <div className="page-title">Ticketing</div>
        <div className="page-desc">{PAGE_DESC}</div>
      </div>

      <section
        className="ticketing-section"
        data-region="ticketing-board"
        aria-labelledby="ticketing-board-title"
      >
        <div className="ticketing-head">
          <h3 id="ticketing-board-title">Board</h3>
          {providerIsClickup ? (
            <Button
              variant="text"
              aria-label="Reload lists and statuses from ClickUp"
              busy={lists.busy || statuses.busy}
              disabled={!listPrereqsMet}
              onClick={reloadAll}
            >
              <span className="ticketing-reload-long" aria-hidden="true">
                ↻ Reload from ClickUp
              </span>
              <span className="ticketing-reload-short" aria-hidden="true">
                ↻ Reload
              </span>
            </Button>
          ) : null}
        </div>

        <div className="ticketing-rows">
          <ProviderPicker
            value={cfg.provider}
            help={providerIsClickup ? '' : MANUAL_HELP}
            onPick={pickProvider}
          />

          {providerIsClickup ? (
            <>
              <Field
                className="ticketing-row"
                label="Team ID"
                help={TEAM_HELP}
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

              <Field
                className="ticketing-row"
                label="List"
                help={<FieldHelp hint={listView.hint} help={LIST_HELP} />}
                control={{
                  kind: 'select',
                  name: 'listId',
                  value: cfg.listId ?? '',
                  disabled: listView.controlDisabled,
                  options: listView.options,
                  onChange: (value) => {
                    // Changing the list invalidates the statuses the previous one
                    // offered; the reducer drops the cache and the auto-load
                    // effect re-arms itself on the new list.
                    setCfg({ listId: value || undefined });
                    listsRequested.current = true;
                  },
                }}
              />

              <TicketingRow label="API token" help={TOKEN_HELP}>
                <TokenControl configured={tokenConfigured} />
              </TicketingRow>
            </>
          ) : null}
        </div>

        {providerIsClickup ? (
          <div
            className={
              connection.ok
                ? 'ticketing-connection ok'
                : connection.text
                  ? 'ticketing-connection warn'
                  : 'ticketing-connection'
            }
            data-region="ticketing-connection-status"
            role="status"
            aria-live="polite"
          >
            {connection.text ? (
              <>
                <span className="dot" aria-hidden="true" />
                {connection.text}
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      {providerIsClickup ? (
        <TicketingBehavior
          searchEnabled={cfg.searchEnabled !== false}
          onSearch={(checked) => setCfg({ searchEnabled: checked })}
          syncSubtasks={modeOf(cfg.syncSubtasks)}
          onSyncSubtasks={(mode: SyncSubtasksMode) => setCfg({ syncSubtasks: mode })}
          start={{
            label: 'Status when work starts',
            name: 'startStatus',
            help: START_HELP,
            view: startView,
            value: cfg.advanceOnStart ? (cfg.startStatus ?? '') : '',
            onChange: (value) =>
              setCfg(
                value === ''
                  ? { advanceOnStart: false }
                  : { advanceOnStart: true, startStatus: value },
              ),
          }}
          ship={{
            label: 'Status when Karst ships',
            name: 'shipStatus',
            help: SHIP_HELP,
            view: shipView,
            value: cfg.advanceOnShip ? (cfg.shipStatus ?? '') : '',
            onChange: (value) =>
              setCfg(
                value === ''
                  ? { advanceOnShip: false }
                  : { advanceOnShip: true, shipStatus: value },
              ),
          }}
        />
      ) : null}
    </div>
  );
}

function modeOf(mode: SyncSubtasksMode | undefined): SyncSubtasksMode {
  return mode ?? 'off';
}

function current(requestId: string | undefined): string {
  if (requestId === undefined) throw new Error('no request id to settle');
  return requestId;
}

/**
 * The line under the Board rows: the loaded status count, or the hint/error
 * that explains why there is nothing loaded. Nothing while idle with the
 * prerequisites met and no fetch started.
 */
function connectionLine(
  fetch: StatusFetch,
  status: MutationStatus,
  listView: DerivedSelect,
  prereqsMet: boolean,
): Connection {
  if (fetch.kind === 'ready' && fetch.statuses.length > 0) {
    const count = fetch.statuses.length;
    return { ok: true, text: `Connected · ${count} ${count === 1 ? 'status' : 'statuses'} loaded` };
  }
  const statusHint =
    fetch.kind === 'failed'
      ? fetch.error
      : fetch.kind === 'ready'
        ? HINT.noStatuses
        : status === 'pending' || prereqsMet
          ? HINT.loadingStatuses
          : HINT.statusesPrereqs;
  // A list hint is the first prerequisite a user can act on, so it comes first.
  return { ok: false, text: listView.hint || statusHint };
}

/** Re-exported for the component test's vocabulary assertions (R-X1). */
export { HINT };
export type { TicketList };
