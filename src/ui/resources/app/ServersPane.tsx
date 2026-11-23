/**
 * The Servers tab — the project's control plane. Regions (shared vocabulary, in
 * stacking order): `toolbar` (summary strip), `main` (shared services, then ticket
 * stacks) and `footer` (legend and the project-wide actions). There is NO
 * project-wide "Start all": a start has a target, and each group owns its own.
 */
import { plural } from '../../../model/notifyText.js';
import { KEPT_RUNNING_CHIP, SERVER_STATUS_MARK, SERVER_STATUS_WORD } from '../../../model/serverStatusText.js';
import type { ServersState } from '../serversState.js';
import { Button } from '../../settings/app/primitives/Button.js';
import { useResourcesApp } from './ResourcesAppContext.js';
import { useHostAction } from './useHostAction.js';
import { ServersEmpty } from './ServersEmpty.js';
import { SharedGroup } from './SharedGroup.js';
import { TicketGroups } from './TicketGroups.js';

function Summary({ state }: { state: ServersState }) {
  const s = state.summary;
  const running = s.runningTickets + s.runningShared;
  return (
    <section className="stats stats-servers" data-region="toolbar" aria-label="Summary">
      <div className="stat">
        <div className="k">Running</div>
        <div className="v">{running}</div>
        <div className="n">{plural(s.runningTickets, 'ticket', 'tickets')} · {s.runningShared} shared</div>
      </div>
      <div className="stat">
        <div className="k">Idle shared</div>
        <div className="v">{s.idleShared}</div>
        <div className="n">no live ticket, not kept running</div>
      </div>
      <div className={`stat${s.finishedWithRunning > 0 ? ' flag' : ''}`}>
        <div className="k">Finished tickets</div>
        <div className="v">{s.finishedWithRunning}</div>
        <div className="n">with servers still running</div>
      </div>
    </section>
  );
}

/** The legend reads the one status table, so a word or a shape changes in one place (RS-17). */
function Legend() {
  const entries = [
    { status: 'running', word: SERVER_STATUS_WORD.running, mark: SERVER_STATUS_MARK.running },
    { status: 'starting', word: SERVER_STATUS_WORD.starting, mark: SERVER_STATUS_MARK.starting },
    { status: 'stopped', word: SERVER_STATUS_WORD.stopped, mark: SERVER_STATUS_MARK.stopped },
    { status: 'failed', word: SERVER_STATUS_WORD.failed, mark: SERVER_STATUS_MARK.failed },
  ];
  return (
    <ul className="legend-key" aria-label="Legend">
      {entries.map((entry) => (
        <li key={entry.status}>
          <span className={`smark smark-${entry.status}`}>
            <span className="smark-shape" aria-hidden="true">{entry.mark}</span> {entry.word}
          </span>
        </li>
      ))}
      <li><span className="chip-kept">{KEPT_RUNNING_CHIP}</span> pinned, never stopped as idle</li>
    </ul>
  );
}

function Footer({ state }: { state: ServersState }) {
  const { send } = useResourcesApp().bridge;
  const logs = useHostAction<[]>('Karst output', (requestId) => send.openLogs(requestId));
  const idle = useHostAction<[]>('Stop idle', (requestId) => send.stopIdle(requestId));
  const why = state.stopIdle.disabledReason;
  const hint = why ?? `Will stop: ${state.stopIdle.names.join(', ')}`;
  return (
    <footer className="sfooter" data-region="footer">
      <Legend />
      <div className="sfooter-actions">
        <Button variant="secondary" busy={logs.busy} spinning={logs.spinning} disabled={logs.disabled} onClick={() => logs.trigger()}>
          Karst output
        </Button>
        <Button
          variant="secondary"
          busy={idle.busy}
          spinning={idle.spinning}
          disabled={idle.disabled || why !== null}
          aria-describedby="stop-idle-why"
          onClick={() => idle.trigger()}
        >
          Stop idle
        </Button>
        <span className="why" id="stop-idle-why">{hint}</span>
        {idle.status === 'failure' && <span className="rownote" role="alert">{idle.error ?? 'Stop idle failed.'}</span>}
        {logs.status === 'failure' && <span className="rownote" role="alert">{logs.error ?? 'Karst output failed.'}</span>}
      </div>
    </footer>
  );
}

export function ServersPane({ state }: { state: ServersState | null }) {
  const { send } = useResourcesApp().bridge;
  if (!state) {
    return <div className="note plain" role="status">Reading servers…</div>;
  }
  const empty = !state.available || state.empty === 'none';
  return (
    <>
      {state.available && <Summary state={state} />}
      <section className="smain" data-region="main">
        {!state.available ? (
          <div className="note plain">{state.unavailableReason}</div>
        ) : state.empty === 'none' ? (
          <ServersEmpty />
        ) : (
          <>
            <SharedGroup rows={state.shared} onLogs={() => send.sharedLogs()} />
            <TicketGroups groups={state.groups} />
          </>
        )}
      </section>
      {!empty && <Footer state={state} />}
    </>
  );
}
