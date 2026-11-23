/**
 * Shared services: the baseline copies every ticket of the project may lean on.
 * A shared service is addressed by its unit key — its `servers` row is deleted
 * and reinserted on every start, so a row id from the last render may be gone.
 */
import type { SharedRowView } from '../serversState.js';
import { Button } from '../../settings/app/primitives/Button.js';
import { KEPT_RUNNING_CHIP, SERVER_VERB_LABEL } from '../../../model/serverStatusText.js';
import { useResourcesApp } from './ResourcesAppContext.js';
import { isTransient, StatusMark, useCopied, useVerb, VerbNote } from './serverBits.js';
import { ServersEmpty } from './ServersEmpty.js';

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

function SharedRow({ row, onLogs }: { row: SharedRowView; onLogs: () => void }) {
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
  }, row.startBudgetMs);
  const copy = useCopied(verb.lastVerb === 'copy' && verb.mutation.status === 'success', verb.mutation.requestId);
  const running = row.status === 'running';
  const failed = row.status === 'failed';
  const locked = verb.locked || isTransient(row.status);
  const copyLabel = row.openable ? SERVER_VERB_LABEL.copyUrl : SERVER_VERB_LABEL.copyAddress;
  const btn = (v: SharedVerb, label: string, aria: string, variant: 'secondary' | 'ghost' = 'secondary') => (
    <Button
      variant={variant}
      size="sm"
      busy={verb.busyOn(v)}
      spinning={verb.spinningOn(v)}
      disabled={locked}
      aria-label={aria}
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
        {row.keptRunning && <span className="chip-kept">{KEPT_RUNNING_CHIP}</span>}
      </div>
      <div className="srow-facts">
        <span className={`saddr${failed ? ' saddr-dim' : ''}`}>
          {failed ? (row.portLabel || '—') : (row.address || '—')}
        </span>
        <Dependents row={row} />
      </div>
      <div className="srow-actions">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={row.pinned}
          aria-label={`Keep ${row.service} running`}
          busy={verb.busyOn('pin')}
          spinning={verb.spinningOn('pin')}
          disabled={locked}
          onClick={() => verb.run('pin')}
        >
          {SERVER_VERB_LABEL.keepRunning}
        </Button>
        {running ? (
          <>
            {btn('restart', 'Restart', `Restart ${row.service}`)}
            {btn('stop', 'Stop', `Stop ${row.service}`)}
            {row.openable && btn('open', 'Open', `Open ${row.service} at ${row.address}`, 'ghost')}
            {row.reachable && (
              <Button
                variant="ghost"
                size="sm"
                className="scopy"
                busy={verb.busyOn('copy')}
                spinning={verb.spinningOn('copy')}
                disabled={locked}
                aria-label={`${copyLabel} ${row.service}`}
                onClick={() => verb.run('copy')}
              >
                {copy.copied ? SERVER_VERB_LABEL.copied : copyLabel}
              </Button>
            )}
          </>
        ) : (
          <>{btn('start', 'Start', `Start ${row.service}`)}</>
        )}
        <Button variant="ghost" size="sm" disabled={locked} aria-label={`Logs for ${row.service}`} onClick={onLogs}>
          Logs
        </Button>
      </div>
      {(failed ? row.reason : '') !== '' ? (
        <p className="srow-reason" role="status">
          <span className="srow-reason-mark" aria-hidden="true">✕</span> {row.reason}
        </p>
      ) : null}
      <VerbNote mutation={verb.mutation} />
    </li>
  );
}

export function SharedGroup({ rows, onLogs }: { rows: readonly SharedRowView[]; onLogs: () => void }) {
  return (
    <section className="group" aria-labelledby="shared-heading">
      <h2 className="ghead" id="shared-heading">
        Shared services<span className="count">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <ServersEmpty />
      ) : (
        <ul className="srows">
          {rows.map((r) => <SharedRow key={r.service} row={r} onLogs={onLogs} />)}
        </ul>
      )}
    </section>
  );
}
