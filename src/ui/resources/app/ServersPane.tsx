/**
 * The Servers tab — the project's control plane. Regions (shared vocabulary, in
 * stacking order): `toolbar` (summary strip), `main` (shared services, then ticket
 * stacks) and `footer` (legend and the project-wide actions). There is NO
 * project-wide "Start all": a start has a target, and each group owns its own.
 */
import type { ServersState } from '../serversState.js';
import { Button } from '../../settings/app/primitives/Button.js';
import { useResourcesApp } from './ResourcesAppContext.js';
import { useHostAction } from './useHostAction.js';
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
        <div className="n">{s.runningTickets} ticket · {s.runningShared} shared</div>
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

function Legend() {
  return (
    <ul className="legend-key" aria-label="Legend">
      <li><span className="smark smark-running"><span className="smark-shape" aria-hidden="true">●</span> Running</span></li>
      <li><span className="smark smark-stopped"><span className="smark-shape" aria-hidden="true">○</span> Stopped</span></li>
      <li><span className="smark smark-failed"><span className="smark-shape" aria-hidden="true">✕</span> Failed</span></li>
      <li><span className="chip-kept">kept running</span> pinned, never stopped as idle</li>
    </ul>
  );
}

function Footer({ state }: { state: ServersState }) {
  const { send } = useResourcesApp().bridge;
  const logs = useHostAction<[]>('Open logs', (requestId) => send.openLogs(requestId));
  const idle = useHostAction<[]>('Stop idle', (requestId) => send.stopIdle(requestId));
  const why = state.stopIdle.disabledReason;
  const hint = why ?? `Will stop: ${state.stopIdle.names.join(', ')}`;
  return (
    <footer className="sfooter" data-region="footer">
      <Legend />
      <div className="sfooter-actions">
        <Button variant="secondary" busy={logs.busy} spinning={logs.spinning} disabled={logs.disabled} onClick={() => logs.trigger()}>
          Open logs
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
        {logs.status === 'failure' && <span className="rownote" role="alert">{logs.error ?? 'Open logs failed.'}</span>}
      </div>
    </footer>
  );
}

export function ServersPane({ state }: { state: ServersState | null }) {
  if (!state) {
    return <div className="note plain" role="status">Reading servers…</div>;
  }
  return (
    <>
      {state.available && <Summary state={state} />}
      <section className="smain" data-region="main">
        {!state.available ? (
          <div className="note plain">{state.unavailableReason}</div>
        ) : state.empty === 'none' ? (
          <div className="note plain">
            No servers in this project yet. Spin a ticket to start its stack; shared services appear here once a ticket needs one.
          </div>
        ) : (
          <>
            <SharedGroup rows={state.shared} />
            <TicketGroups groups={state.groups} />
          </>
        )}
      </section>
      <Footer state={state} />
    </>
  );
}
