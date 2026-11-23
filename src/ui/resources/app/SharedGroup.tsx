/**
 * Shared services: the baseline copies every ticket of the project may lean on.
 * A shared service is addressed by its unit key — its `servers` row is deleted
 * and reinserted on every start, so a row id from the last render may be gone.
 */
import type { SharedRowView } from '../serversState.js';
import { Button } from '../../settings/app/primitives/Button.js';
import { IconButton } from '../../settings/app/primitives/IconButton.js';
import { TablerIcon } from '../../settings/app/primitives/TablerIcon.js';
import { KEPT_RUNNING_CHIP, SERVER_VERB_LABEL } from '../../../model/serverStatusText.js';
import { useResourcesApp } from './ResourcesAppContext.js';
import { isTransient, StatusMark, useCopied, useVerb, VerbNote } from './serverBits.js';
import { ServersEmpty } from './ServersEmpty.js';

const VERB_ICON = { start: 'player-play', restart: 'refresh', stop: 'player-stop', open: 'external-link' } as const;

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
  const btn = (v: 'start' | 'restart' | 'stop' | 'open', aria: string) => (
    <IconButton
      label={aria}
      danger={v === 'stop'}
      className={`sv-${v}`}
      busy={verb.busyOn(v)}
      spinning={verb.spinningOn(v)}
      disabled={locked}
      onClick={() => verb.run(v)}
    >
      <TablerIcon name={VERB_ICON[v]} />
    </IconButton>
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
        <IconButton
          label={`Keep ${row.service} running`}
          aria-pressed={row.pinned}
          busy={verb.busyOn('pin')}
          spinning={verb.spinningOn('pin')}
          disabled={locked}
          onClick={() => verb.run('pin')}
        >
          <TablerIcon name={'pin'} />
        </IconButton>
        {running ? (
          <>
            {btn('restart', `Restart ${row.service}`)}
            {btn('stop', `Stop ${row.service}`)}
            {row.openable && btn('open', `Open ${row.service} at ${row.address}`)}
            {row.reachable && (
              <IconButton
                label={`${copyLabel} ${row.service}`}
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
          <>{btn('start', `Start ${row.service}`)}</>
        )}
        <IconButton label={`Logs for ${row.service}`} disabled={locked} onClick={onLogs}>
          <TablerIcon name="terminal-2" />
        </IconButton>
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
