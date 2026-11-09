/**
 * The dashboard's Servers panel: a `Section` (title, count, summary, ticket-scoped actions) over rows on the
 * shared Row pattern, rendered by React into the page's `.panel` root (`data-region="servers"`).
 *
 * The services filter is component state: it starts from the persisted value and every change is handed to
 * `ViewPersistence`, which writes it with the rest of the view state. The header's Logs and Env buttons open the overlay views
 * (`Overlays.tsx`).
 */
import { memo, useCallback, useState } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend, useOverlays, usePersistence } from './DashboardAppContext.js';
import { EmptyState } from './EmptyState.js';
import { RegionPortal } from './RegionPortal.js';
import { LocalAction, PostAction } from './ServerActions.js';
import { isOnline, isSharedFault, ServerRow, SharedRow, type OwnServer, type SharedServer } from './ServerRows.js';
import { GroupHeader, Section } from './Section.js';
import { useSlice } from './useSlice.js';
import './Section.css';
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

/**
 * Whole-ticket controls, in the panel HEADER: they act on every service, so they survive the states
 * where the body has no rows. Each disables itself when it would be a no-op and says why. TICKET-scoped,
 * always and only: the panel also lists shared rows, and a header button that reached those would stop
 * another ticket's stack.
 */
const ServerOps = memo(function ServerOps({ slice }: { readonly slice: ServersSlice }) {
  const send = useDashboardSend();
  const overlays = useOverlays();
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
      <LocalAction data-act="server-logs-request" label="View server logs" icon="terminal-2" run={overlays.openLogs}
        disabledWhy={none && slice.shared.length === 0 ? 'No services to show logs for' : null} />
      {/* Env overrides are a property of the TICKET, not of a running process: available even with no rows. */}
      <LocalAction data-act="env-overrides-open" label="Configure environment variables" icon="settings" run={overlays.openEnv} />
    </>
  );
});

/** The two empty states stay distinct: a PROMPT (nothing runs, the header's Start fixes that) versus a STATEMENT (nothing here can run). */
function Empty({ runnable }: { readonly runnable: boolean }) {
  return runnable ? (
    <EmptyState icon="server-2" heading="No servers running." sub="Start the services in scope to get their local addresses here." />
  ) : (
    <EmptyState
      icon="circle-x"
      tone="dead"
      heading="No runnable services in scope."
      sub="This ticket scopes only repositories without a service block, so there is nothing here to run."
    />
  );
}

/**
 * The header's one line: the ticket part and the shared part never mix their counts (arch:SHARED-VIEW).
 * Ticket: `all running`, or the non-zero parts of `N running · N failed · N offline`. Shared: `shared: ok` or `shared: N failing`.
 */
export function serversSummary(servers: readonly OwnServer[], shared: readonly SharedServer[]): string {
  const parts: string[] = [];
  if (servers.length > 0) {
    const running = servers.filter(isOnline).length;
    const failed = servers.filter((s) => s.status === 'failed').length;
    const offline = servers.length - running - failed;
    parts.push(
      running === servers.length
        ? 'all running'
        : [`${running} running`, failed > 0 ? `${failed} failed` : '', offline > 0 ? `${offline} offline` : ''].filter(Boolean).join(' · '),
    );
  }
  if (shared.length > 0) {
    const failing = shared.filter(isSharedFault).length;
    parts.push(failing === 0 ? 'shared: ok' : `shared: ${failing} failing`);
  }
  return parts.join(' · ');
}

function ServersBody({ slice }: { readonly slice: ServersSlice }) {
  const send = useDashboardSend();
  const persistence = usePersistence();
  const [filter, setFilter] = useState(() => persistence.srvFilter);
  const { servers, shared } = slice;
  const total = servers.length + shared.length;
  if (total === 0) return <Empty runnable={slice.runnable} />;

  const filterable = total > FILTER_ABOVE;
  const needle = filter.trim().toLowerCase();
  const hit = (s: { readonly service: string }): boolean => !filterable || !needle || s.service.toLowerCase().includes(needle);
  const ticketShown = servers.filter(hit);
  const sharedShown = shared.filter(hit);
  const noMatch = filterable && needle !== '' && ticketShown.length === 0 && sharedShown.length === 0;
  // A group header earns its place only when there are two groups to tell apart.
  const grouped = shared.length > 0;
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
              persistence.filter(e.currentTarget.value);
            }}
          />
        </div>
      ) : null}
      <div className="scroll">
        {noMatch ? (
          <div className="nomatch">{`No service matches “${filter}”.`}</div>
        ) : (
          <>
            {ticketShown.length > 0 ? (
              <>
                {grouped ? <GroupHeader label="Ticket services" count={ticketShown.length} note="run from this ticket's worktrees" /> : null}
                {ticketShown.map((s) => (
                  <ServerRow key={s.id} s={s} send={send} />
                ))}
              </>
            ) : servers.length === 0 ? (
              // A shared half alone is a truthful stack: it must not fall back to "No servers running".
              <>
                <GroupHeader label="Ticket services" count={0} note="run from this ticket's worktrees" />
                <div className="srvnone">No ticket services — only shared ones are in scope.</div>
              </>
            ) : null}
            {sharedShown.length > 0 ? (
              <>
                <GroupHeader label="Shared services" count={sharedShown.length} note="reused across tickets · not touched by header actions" />
                {sharedShown.map((s) => (
                  <SharedRow key={s.service} s={s} send={send} />
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

export const ServersPanel = memo(function ServersPanel() {
  const slice = useSlice(selectServers);
  const total = slice ? slice.servers.length + slice.shared.length : 0;
  const summary = slice ? serversSummary(slice.servers, slice.shared) : '';
  return (
    <RegionPortal region="servers">
      <Section
        title="Servers"
        count={total}
        summary={summary}
        summaryTitle={summary}
        actions={slice ? <ServerOps slice={slice} /> : null}
        bodyId="servers"
      >
        {slice ? <ServersBody slice={slice} /> : null}
      </Section>
    </RegionPortal>
  );
});
