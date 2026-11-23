/**
 * Ticket stacks: each ticket's own running services, grouped under the ticket.
 * Rows are addressed by `servers.id`; the host re-reads before acting and names a
 * row that vanished mid-action.
 */
import type { ServerRowView, TicketGroupView } from '../serversState.js';
import { Button } from '../../settings/app/primitives/Button.js';
import { IconButton } from '../../settings/app/primitives/IconButton.js';
import { TablerIcon } from '../../settings/app/primitives/TablerIcon.js';
import { useResourcesApp } from './ResourcesAppContext.js';
import { isTransient, StatusMark, useCopied, useVerb, VerbNote } from './serverBits.js';
import { ServersEmpty } from './ServersEmpty.js';

const VERB_ICON = { start: 'player-play', restart: 'refresh', stop: 'player-stop' } as const;

type RowVerb = 'start' | 'restart' | 'stop' | 'open' | 'copy';

function TicketRow({ row, ticketKey, onLogs }: { row: ServerRowView; ticketKey: string; onLogs: () => void }) {
  const { send } = useResourcesApp().bridge;
  // One budget for the row: a Start (or a Restart) may take its declared health
  // timeout before the request is "unknown" (RS-3).
  const verb = useVerb<RowVerb>(`${row.service} action`, (requestId, v) => {
    switch (v) {
      case 'start': return send.serverStart(row.serverId, requestId);
      case 'restart': return send.serverRestart(row.serverId, requestId);
      case 'stop': return send.serverStop(row.serverId, requestId);
      case 'open': return send.serverOpen(row.serverId, requestId);
      case 'copy': return send.serverCopy(row.serverId, requestId);
    }
  }, row.startBudgetMs);
  const copy = useCopied(verb.lastVerb === 'copy' && verb.mutation.status === 'success', verb.mutation.requestId);
  const target = `${row.service} of ${ticketKey}`;
  // A verb the host holds on the row disables its other verbs; the state is
  // transient, not a crash (RS-3).
  const locked = verb.locked || isTransient(row.status);
  const failed = row.status === 'failed';
  const btn = (v: 'start' | 'restart' | 'stop', aria: string) => (
    <IconButton
      label={aria}
      busy={verb.busyOn(v)}
      spinning={verb.spinningOn(v)}
      disabled={locked}
      onClick={() => verb.run(v)}
    >
      <TablerIcon name={VERB_ICON[v]} />
    </IconButton>
  );
  const copyLabel = row.openable ? 'Copy URL' : 'Copy address';
  return (
    <li className="srow" data-server={row.serverId}>
      <div className="srow-id">
        <StatusMark status={row.status} />
        <span className="sname">{row.service}</span>
      </div>
      <div className="srow-facts">
        {row.openable ? (
          // The address IS the Open affordance on a ticket row (RS-15, @ui:SG-25).
          <button
            type="button"
            className="saddr-link"
            disabled={locked}
            aria-label={`Open ${target} at ${row.address}`}
            onClick={() => verb.run('open')}
          >
            {row.address}
          </button>
        ) : (
          <span className={`saddr${failed ? ' saddr-dim' : ''}`}>{failed ? (row.portLabel || '—') : (row.address || '—')}</span>
        )}
      </div>
      <div className="srow-actions">
        {row.status === 'running' ? (
          <>
            {btn('restart', `Restart ${target}`)}
            {btn('stop', `Stop ${target}`)}
            {row.reachable && (
              <IconButton
                label={`${copyLabel} ${target}`}
                data-copied={copy.copied ? "true" : undefined}
                busy={verb.busyOn('copy')}
                spinning={verb.spinningOn('copy')}
                disabled={locked}
                onClick={() => verb.run('copy')}
              >
                <TablerIcon name={copy.copied ? 'check' : 'copy'} />
              </IconButton>
            )}
          </>
        ) : (
          <>
            {btn('start', `Start ${target}`)}
            {failed && (
              <IconButton label={`Logs for ${target}`} disabled={locked} onClick={onLogs}>
                <TablerIcon name="terminal-2" />
              </IconButton>
            )}
          </>
        )}
      </div>
      {failed && row.reason && (
        <p className="srow-reason" role="status">
          <span className="srow-reason-mark" aria-hidden="true">✕</span> {row.reason}
        </p>
      )}
      <VerbNote mutation={verb.mutation} />
    </li>
  );
}

type GroupVerb = 'stop-all' | 'logs';

function TicketGroup({ group }: { group: TicketGroupView }) {
  const { send } = useResourcesApp().bridge;
  const verb = useVerb<GroupVerb>(`${group.key} action`, (requestId, v) => {
    if (v === 'stop-all') send.ticketStopAll(group.ticketId, requestId);
    else send.ticketLogs(group.ticketId, requestId);
  });
  const headingId = `ticket-${group.ticketId}`;
  const countId = `${headingId}-count`;
  return (
    <section className="group" aria-labelledby={headingId}>
      <div className="ghead ghead-ticket">
        <h3 className="gtitle" id={headingId}>
          <span className="tkey">{group.key}</span>
          {group.title && <span className="gname">{group.title}</span>}
        </h3>
        <span className="gmeta">
          {group.stage && <span className="stage">{group.stage}</span>}
          <span className="count" id={countId}>{group.running} of {group.total} running</span>
        </span>
        <span className="gactions">
          <Button
            variant="ghost"
            size="sm"
            busy={verb.busyOn('logs')}
            spinning={verb.spinningOn('logs')}
            disabled={verb.locked}
            aria-label={`Logs for ${group.key}`}
            icon="terminal-2"
            onClick={() => verb.run('logs')}
          >
            Logs
          </Button>
          <Button
            variant="secondary"
            size="sm"
            busy={verb.busyOn('stop-all')}
            spinning={verb.spinningOn('stop-all')}
            disabled={verb.locked || group.running === 0}
            aria-label={`Stop all servers of ${group.key}`}
            aria-describedby={countId}
            icon="player-stop"
            onClick={() => verb.run('stop-all')}
          >
            Stop all
          </Button>
        </span>
      </div>
      {(group.doneStillRunning || group.cleanUp || group.downServices.length > 0) && (
        <p className="gflags">
          {group.doneStillRunning && <span className="flag">ticket done · servers still running</span>}
          {group.cleanUp && <span className="flag">archived · clean up</span>}
          {group.downServices.length > 0 && <span className="flag flag-down">dependency down: {group.downServices.join(', ')}</span>}
        </p>
      )}
      <VerbNote mutation={verb.mutation} />
      <ul className="srows">
        {group.servers.map((r) => (
          <TicketRow key={r.serverId} row={r} ticketKey={group.key} onLogs={() => send.ticketLogs(group.ticketId)} />
        ))}
      </ul>
    </section>
  );
}

export function TicketGroups({ groups }: { groups: readonly TicketGroupView[] }) {
  return (
    <div className="tickets">
      <h2 className="ghead" id="tickets-heading">Ticket stacks<span className="count">{groups.length}</span></h2>
      {groups.length === 0 ? <ServersEmpty /> : groups.map((g) => <TicketGroup key={g.ticketId} group={g} />)}
    </div>
  );
}
