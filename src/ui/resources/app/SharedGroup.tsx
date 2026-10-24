/**
 * Shared services: the baseline copies every ticket of the project may lean on.
 * A shared service is addressed by its unit key — its `servers` row is deleted
 * and reinserted on every start, so a row id from the last render may be gone.
 */
import type { SharedRowView } from '../serversState.js';
import { Button } from '../../settings/app/primitives/Button.js';
import { useResourcesApp } from './ResourcesAppContext.js';
import { StatusMark, useVerb, VerbNote } from './serverBits.js';

type SharedVerb = 'start' | 'restart' | 'stop' | 'pin' | 'open' | 'copy';

function Dependents({ row }: { row: SharedRowView }) {
  if (row.dependents.length === 0) {
    return <span className="deps deps-none">no live tickets</span>;
  }
  return (
    <span className="deps">
      <span className="deps-lead">used by</span>{' '}
      {row.dependents.map((d, i) => (
        <span key={`${d.label}:${d.done}`} className="dep">
          {d.label}{d.done && <span className="dep-done"> (done)</span>}
          {i < row.dependents.length - 1 ? ', ' : ''}
        </span>
      ))}
    </span>
  );
}

function SharedRow({ row }: { row: SharedRowView }) {
  const { send } = useResourcesApp().bridge;
  const verb = useVerb<SharedVerb>(`${row.service} action`, (requestId, v) => {
    switch (v) {
      case 'start': return send.sharedStart(row.service, requestId);
      case 'restart': return send.sharedRestart(row.service, requestId);
      case 'stop': return send.sharedStop(row.service, requestId);
      case 'pin': return send.sharedPin(row.service, !row.pinned, requestId);
      case 'open': return send.serverOpen(row.serverId, requestId);
      case 'copy': return send.serverCopy(row.serverId, requestId);
    }
  });
  const running = row.status === 'running';
  const btn = (v: SharedVerb, label: string, variant: 'secondary' | 'ghost' = 'secondary') => (
    <Button
      variant={variant}
      size="sm"
      busy={verb.busyOn(v)}
      spinning={verb.spinningOn(v)}
      disabled={verb.locked}
      onClick={() => verb.run(v)}
    >
      {label}
    </Button>
  );
  return (
    <li className="srow" data-service={row.service}>
      <div className="srow-id">
        <StatusMark status={row.status} />
        <span className="sname">{row.service}</span>
        {row.baseBranch && <span className="chip-branch" title="Base branch this shared copy serves">{row.baseBranch}</span>}
        {row.keptRunning && <span className="chip-kept">kept running</span>}
      </div>
      <div className="srow-facts">
        <span className="saddr">{row.address || '—'}</span>
        <Dependents row={row} />
      </div>
      <div className="srow-actions">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={row.pinned}
          busy={verb.busyOn('pin')}
          spinning={verb.spinningOn('pin')}
          disabled={verb.locked}
          onClick={() => verb.run('pin')}
        >
          Keep running
        </Button>
        {running ? (
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

export function SharedGroup({ rows }: { rows: readonly SharedRowView[] }) {
  return (
    <section className="group" aria-labelledby="shared-heading">
      <h2 className="ghead" id="shared-heading">
        Shared services<span className="count">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="gempty">No shared service has run yet. One starts when a ticket that needs it is spun.</p>
      ) : (
        <ul className="srows">
          {rows.map((r) => <SharedRow key={r.service} row={r} />)}
        </ul>
      )}
    </section>
  );
}
