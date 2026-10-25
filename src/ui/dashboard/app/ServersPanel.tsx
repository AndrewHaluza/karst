/**
 * The dashboard's Servers panel, rendered by React into the page's existing containers
 * (`#srvCount`, `#srvOps`, `#servers`) through three `RegionPortal`s. The panel root and its
 * "Servers" caption stay static in `webview.html`. Same DOM as the vanilla renderer it replaced
 * (`renderServers`, `panelOps`, `serversEmpty`).
 *
 * The services filter is component state. Vanilla still owns persistence (`vscode.setState`) until
 * the switch-over slice, so the filter starts from the persisted value (read-only) and every change
 * is announced on the transitional seam in `serversSeam.ts`.
 */
import { memo, useCallback, useState } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardBridge, useDashboardSend } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { RegionPortal } from './RegionPortal.js';
import { LocalAction, PostAction } from './ServerActions.js';
import { GroupHead, isOnline, ServerRow, SharedRow, type OwnServer, type SharedServer } from './ServerRows.js';
import { announce, announceFilter, OPEN_ENV_OVERRIDES_EVENT, OPEN_SERVER_LOGS_EVENT } from './serversSeam.js';
import { useSlice } from './useSlice.js';
import './ServersPanel.css';

interface ServersSlice {
  readonly servers: readonly OwnServer[];
  readonly shared: readonly SharedServer[];
  /** False when nothing in scope declares a service: nothing can ever run. */
  readonly runnable: boolean;
}

/** null before the first host snapshot: the panel is empty. */
const selectServers = (snapshot: DashboardSnapshot): ServersSlice | null =>
  snapshot.state
    ? {
        servers: snapshot.state.servers ?? [],
        shared: snapshot.state.sharedServers ?? [],
        runnable: snapshot.state.hasRunnableRepos !== false,
      }
    : null;

/** The filter earns its row only once scanning is actually hard. */
const FILTER_ABOVE = 6;

const announcer = (name: typeof OPEN_SERVER_LOGS_EVENT | typeof OPEN_ENV_OVERRIDES_EVENT) => () => announce(name);
const openLogs = announcer(OPEN_SERVER_LOGS_EVENT);
const openEnv = announcer(OPEN_ENV_OVERRIDES_EVENT);

/**
 * Whole-ticket controls, in the panel HEADER: they act on every service, so they survive the states
 * where the body has no rows. Each disables itself when it would be a no-op and says why. TICKET-scoped,
 * always and only: the panel also lists shared rows, and a header button that reached those would stop
 * another ticket's stack.
 */
const ServerOps = memo(function ServerOps({ slice }: { readonly slice: ServersSlice }) {
  const send = useDashboardSend();
  const spin = useCallback((r: string) => send.spinServers(r), [send]);
  const restart = useCallback((r: string) => send.restartServers(r), [send]);
  const stop = useCallback((r: string) => send.stopServers(r), [send]);
  // Nothing in scope can ever run: these would be permanent dead affordances, so they are absent.
  if (!slice.runnable) return null;
  const none = slice.servers.length === 0;
  const anyOffline = slice.servers.some((s) => !isOnline(s));
  const anyRunning = slice.servers.some(isOnline);
  return (
    <>
      <PostAction data-act="spin-servers" label="Start all ticket services" icon="player-play" post={spin}
        disabledWhy={!none && !anyOffline ? 'Every ticket service is already running' : null} />
      <PostAction data-act="restart-servers" label="Restart all ticket services" icon="refresh" post={restart}
        disabledWhy={none ? 'No ticket services to restart' : null} />
      <PostAction data-act="stop-servers" label="Stop all ticket services" icon="player-stop" post={stop}
        disabledWhy={!anyRunning ? 'No ticket service is running' : null} />
      <LocalAction data-act="server-logs-request" label="View server logs" icon="terminal-2" run={openLogs}
        disabledWhy={none && slice.shared.length === 0 ? 'No services to show logs for' : null} />
      {/* Env overrides are a property of the TICKET, not of a running process: available even with no rows. */}
      <LocalAction data-act="env-overrides-open" label="Configure environment variables" icon="settings" run={openEnv} />
    </>
  );
});

/** The two empty states stay distinct: a PROMPT (nothing runs, the header's Start fixes that) versus a STATEMENT (nothing here can run). */
function Empty({ runnable }: { readonly runnable: boolean }) {
  return runnable ? (
    <div className="estate">
      <span className="emark">
        <Icon name="server-2" />
      </span>
      <div>
        <div className="ehead">No servers running</div>
        <div className="esub">Start the services in scope to get their local addresses here.</div>
      </div>
    </div>
  ) : (
    <div className="estate dead">
      <span className="emark">
        <Icon name="circle-x" />
      </span>
      <div>
        <div className="ehead">No runnable services in scope</div>
        <div className="esub">This ticket scopes only repositories without a service block, so there is nothing here to run.</div>
      </div>
    </div>
  );
}

function persistedFilter(getState: () => unknown): string {
  try {
    const raw = getState();
    const value = raw && typeof raw === 'object' ? (raw as { srvFilter?: unknown }).srvFilter : undefined;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function ServersBody({ slice }: { readonly slice: ServersSlice }) {
  const send = useDashboardSend();
  const bridge = useDashboardBridge();
  const [filter, setFilter] = useState(() => persistedFilter(bridge.getState));
  const { servers, shared } = slice;
  const total = servers.length + shared.length;
  if (total === 0) return <Empty runnable={slice.runnable} />;

  const filterable = total > FILTER_ABOVE;
  const needle = filter.trim().toLowerCase();
  const hit = (s: { readonly service: string }): boolean => !filterable || !needle || s.service.toLowerCase().includes(needle);
  const ticketShown = servers.filter(hit);
  const sharedShown = shared.filter(hit);
  const noMatch = filterable && needle !== '' && ticketShown.length === 0 && sharedShown.length === 0;
  return (
    <>
      {filterable ? (
        <div className="filter">
          <label className="sr" htmlFor="srvFilter">
            Filter services
          </label>
          <input
            id="srvFilter"
            className="k-input"
            type="search"
            placeholder={`Filter ${total} services…`}
            value={filter}
            data-filter=""
            onChange={(e) => {
              setFilter(e.currentTarget.value);
              announceFilter(e.currentTarget.value);
            }}
          />
        </div>
      ) : null}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr">Status</span>
              </th>
              <th scope="col">Service</th>
              {/* The address-ops column sits UNDER the Address header: Open is part of the address. */}
              <th scope="col" colSpan={2}>
                Address
              </th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {noMatch ? (
              <tr>
                <td colSpan={5}>
                  <div className="nomatch">{`No service matches “${filter}”.`}</div>
                </td>
              </tr>
            ) : (
              <>
                {ticketShown.length > 0 ? (
                  <>
                    <GroupHead label="Ticket services" count={ticketShown.length} note="run from this ticket's worktrees" />
                    {ticketShown.map((s) => (
                      <ServerRow key={s.id} s={s} send={send} />
                    ))}
                  </>
                ) : servers.length === 0 ? (
                  // A shared half alone is a truthful stack: it must not fall back to "No servers running".
                  <>
                    <GroupHead label="Ticket services" count={0} note="run from this ticket's worktrees" />
                    <tr>
                      <td colSpan={5}>
                        <span className="srvnone">No ticket services</span>
                      </td>
                    </tr>
                  </>
                ) : null}
                {sharedShown.length > 0 ? (
                  <>
                    <GroupHead label="Shared services" count={sharedShown.length} note="one copy per repository, from the base branch" />
                    {sharedShown.map((s) => (
                      <SharedRow key={s.service} s={s} send={send} />
                    ))}
                  </>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export const ServersPanel = memo(function ServersPanel() {
  const slice = useSlice(selectServers);
  const total = slice ? slice.servers.length + slice.shared.length : 0;
  return (
    <>
      <RegionPortal id="srvCount">{total ? String(total) : null}</RegionPortal>
      <RegionPortal id="srvOps">{slice ? <ServerOps slice={slice} /> : null}</RegionPortal>
      <RegionPortal id="servers">{slice ? <ServersBody slice={slice} /> : null}</RegionPortal>
    </>
  );
});
