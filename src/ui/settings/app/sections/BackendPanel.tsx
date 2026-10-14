/**
 * The sandbox backend selector on the Agents page (arch:AC-32): one row per core
 * with only the values that core can use, what each core actually resolves to,
 * and the readiness of the backends some core selects. Opt-in; host is the
 * default and choosing it deletes the core's key.
 */
import { useEffect, useMemo } from 'react';
import type { Manifest } from '../../../../manifest/types.js';
import {
  allowedBackends,
  BACKEND_CORES,
  wantedBackends,
  type AgentBackends,
  type BackendCore,
  type CoreBackend,
} from '../../../../agent/backendChoices.js';
import {
  deriveEffectiveBackends,
  formatEffectiveBackends,
  type BackendStatus,
} from '../../../../agent/effectiveBackend.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';

const UNCHECKED: BackendStatus = { ok: false, reason: 'not checked yet' };
const NO_SANDBOX_NOTE = 'no sandbox yet';

function setCoreBackend(core: BackendCore, value: CoreBackend): (draft: Manifest) => Manifest {
  return (draft) => {
    const kept = Object.entries(draft.agentBackends ?? {}).filter(([key]) => key !== core);
    const entries = value === 'host' ? kept : [...kept, [core, value]];
    const manifest = { ...draft };
    delete manifest.agentBackends;
    return entries.length === 0 ? manifest : { ...manifest, agentBackends: Object.fromEntries(entries) as AgentBackends };
  };
}

function statusText(status: BackendStatus | undefined): string {
  if (status === undefined) return 'not checked';
  return status.ok ? 'ready' : status.reason;
}

export function BackendPanel() {
  const { state, edit, send } = useSettingsApp();
  const backends = state.draft.agentBackends;
  const want = wantedBackends(backends);
  const status = state.backendStatus ?? undefined;
  // Probe on mount and whenever the selection changes; the host answers with
  // `backend-status` and preflights only the backends some core selects.
  useEffect(() => {
    send.checkBackends({ sbx: want.sbx, docker: want.docker });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the two flags
  }, [want.sbx, want.docker]);
  const rows = useMemo(
    () =>
      deriveEffectiveBackends({
        backends,
        cores: BACKEND_CORES,
        sbx: status?.sbx ?? UNCHECKED,
        docker: status?.docker ?? UNCHECKED,
      }),
    [backends, status],
  );
  return (
    <div className="section-block" data-region="backend">
      <div className="section-head">
        <div>
          <div className="section-title">Sandbox backend</div>
          <div className="section-desc">
            Run agent sessions inside a sandbox so they ask for fewer permissions. Choose per core: host stays
            the default, and an unavailable backend falls back to a prompted host session with the reason shown.
          </div>
        </div>
      </div>
      {BACKEND_CORES.map((core) => {
        const allowed = allowedBackends(core);
        const current = backends?.[core] ?? 'host';
        return (
          <div key={core} className="field-row" data-testid={`backend-row-${core}`}>
            <span className="field-label" id={`backend-label-${core}`}>{core}</span>
            <div role="radiogroup" aria-labelledby={`backend-label-${core}`} className="segmented">
              {allowed.map((value) => (
                <Button
                  key={value}
                  role="radio"
                  aria-checked={current === value}
                  variant={current === value ? 'secondary' : 'ghost'}
                  size="sm"
                  disabled={allowed.length === 1}
                  onClick={() => edit(setCoreBackend(core, value))}
                >
                  {value}
                </Button>
              ))}
            </div>
            {allowed.length === 1 ? <span className="field-help">{NO_SANDBOX_NOTE}</span> : null}
          </div>
        );
      })}
      <div data-testid="effective-backend" className="field-help">
        {formatEffectiveBackends(rows)}
      </div>
      <div className="field-help">
        {want.sbx ? <div data-testid="backend-status-sbx">sbx: {statusText(status?.sbx)}</div> : null}
        {want.docker ? <div data-testid="backend-status-docker">docker: {statusText(status?.docker)}</div> : null}
      </div>
      <Button variant="secondary" size="sm" onClick={() => send.checkBackends({ sbx: want.sbx, docker: want.docker })}>
        Re-check
      </Button>
    </div>
  );
}
