/**
 * The sandbox backend selector on the Agents page (arch:AC-32): the project's
 * `agentBackend`, what each core actually resolves to, and the readiness of each
 * backend. Opt-in; host is the default and a cleared selection deletes the key.
 */
import { useEffect, useMemo } from 'react';
import type { AgentBackend, Manifest } from '../../../../manifest/types.js';
import {
  deriveEffectiveBackends,
  formatEffectiveBackends,
  type BackendStatus,
} from '../../../../agent/effectiveBackend.js';
import { readField, useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';
import { usePickerInputs } from './usePickerInputs.js';

const OPTIONS = [
  { value: 'host', label: 'host (prompted, no sandbox)' },
  { value: 'sbx', label: 'sbx (Docker Sandboxes: claude, codex)' },
  { value: 'docker', label: 'docker (opencode, opencode2)' },
] as const;

const UNCHECKED: BackendStatus = { ok: false, reason: 'not checked yet' };

function setBackend(value: AgentBackend): (draft: Manifest) => Manifest {
  return (draft) => {
    const next = { ...draft };
    delete next.agentBackend;
    return value === 'host' ? next : { ...next, agentBackend: value };
  };
}

function statusText(status: BackendStatus | undefined): string {
  if (status === undefined) return 'not checked';
  return status.ok ? 'ready' : status.reason;
}

export function BackendPanel() {
  const { state, edit, send } = useSettingsApp();
  const draft = state.draft;
  const { cores } = usePickerInputs();
  const status = state.backendStatus ?? undefined;
  // Probe once on mount; the host answers with `backend-status`.
  useEffect(() => {
    send.checkBackends();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);
  const setting = readField<AgentBackend>(draft, 'agentBackend', 'host');
  const rows = useMemo(
    () =>
      deriveEffectiveBackends({
        setting,
        cores: cores.filter((c) => !c.disabled).map((c) => c.id),
        sbx: status?.sbx ?? UNCHECKED,
        docker: status?.docker ?? UNCHECKED,
      }),
    [setting, cores, status],
  );
  return (
    <div className="section-block" data-region="backend">
      <div className="section-head">
        <div>
          <div className="section-title">Sandbox backend</div>
          <div className="section-desc">
            Run agent sessions inside a sandbox so they ask for fewer permissions. Opt-in: host stays the
            default, and an unavailable backend falls back to a prompted host session with the reason shown.
          </div>
        </div>
      </div>
      <Field
        label="Agent backend"
        control={{
          kind: 'select',
          name: 'agentBackend',
          value: setting,
          options: OPTIONS,
          onChange: (value) => edit(setBackend(value as AgentBackend)),
        }}
      />
      <div data-testid="effective-backend" className="field-help">
        {formatEffectiveBackends(rows)}
      </div>
      <div className="field-help">
        <div data-testid="backend-status-sbx">sbx: {statusText(status?.sbx)}</div>
        <div data-testid="backend-status-docker">docker: {statusText(status?.docker)}</div>
      </div>
      <Button variant="secondary" size="sm" onClick={() => send.checkBackends()}>
        Re-check
      </Button>
    </div>
  );
}
