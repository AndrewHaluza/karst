/**
 * Ticket stacks: each ticket's own running services, grouped under the ticket.
 * Rows are addressed by `servers.id`; the host re-reads before acting and names a
 * row that vanished mid-action.
 */
import type { ServerRowView, TicketGroupView } from '../serversState.js';
import { Button } from '../../settings/app/primitives/Button.js';
import { useResourcesApp } from './ResourcesAppContext.js';
import { StatusMark, useVerb, VerbNote } from './serverBits.js';

type RowVerb = 'start' | 'restart' | 'stop' | 'open' | 'copy';

function TicketRow({ row }: { row: ServerRowView }) {
  const { send } = useResourcesApp().bridge;
  const verb = useVerb<RowVerb>(`${row.service} action`, (requestId, v) => {
    switch (v) {
      case 'start': return send.serverStart(row.serverId, requestId);
      case 'restart': return send.serverRestart(row.serverId, requestId);
      case 'stop': return send.serverStop(row.serverId, requestId);
      case 'open': return send.serverOpen(row.serverId, requestId);
      case 'copy': return send.serverCopy(row.serverId, requestId);
    }
  });
  const btn = (v: RowVerb, label: string, variant: 'secondary' | 'ghost' = 'secondary') => (
    <Button variant={variant} size="sm" busy={verb.busyOn(v)} spinning={verb.spinningOn(v)} disabled={verb.locked} onClick={() => verb.run(v)}>
      {label}
    </Button>
  );
  return (
    <li className="srow" data-server={row.serverId}>
      <div className="srow-id">
        <StatusMark status={row.status} />
        <span className="sname">{row.service}</span>
      </div>
      <div className="srow-facts"><span className="saddr">{row.address || '—'}</span></div>
      <div className="srow-actions">
        {row.status === 'running' ? (
          <>
            {btn('restart', 'Restart')}
            {btn('stop', 'Stop')}
            {row.reachable && btn('open', 'Open', 'ghost')}
            {row.reachable && btn('copy', 'Copy URL', 'ghost')}
          </>
        ) : (
          btn('start', 'Start')
        )}
      </div>
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
          <Button variant="ghost" size="sm" busy={verb.busyOn('logs')} spinning={verb.spinningOn('logs')} disabled={verb.locked} onClick={() => verb.run('logs')}>
            Logs
          </Button>
          <Button
            variant="secondary"
            size="sm"
            busy={verb.busyOn('stop-all')}
            spinning={verb.spinningOn('stop-all')}
            disabled={verb.locked || group.running === 0}
            aria-describedby={countId}
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
        {group.servers.map((r) => <TicketRow key={r.serverId} row={r} />)}
      </ul>
    </section>
  );
}

export function TicketGroups({ groups }: { groups: readonly TicketGroupView[] }) {
  return (
    <div className="tickets">
      <h2 className="ghead" id="tickets-heading">Ticket stacks<span className="count">{groups.length}</span></h2>
      {groups.length === 0 ? (
        <p className="gempty">No ticket has servers in this project. Spin a ticket to start its stack.</p>
      ) : (
        groups.map((g) => <TicketGroup key={g.ticketId} group={g} />)
      )}
    </div>
  );
}
