/**
 * The sandbox backend selector on the Agents page (arch:AC-32): one row per core
 * with only the values that core can use, what each core actually resolves to,
 * and the readiness of the selected backend in that row. Opt-in; host is the
 * default and choosing it deletes the core's key.
 *
 * SET-46: the row names the core by its display name and mark, never the raw id
 * (`agy` is `Antigravity CLI`), and the segments read `Host` / `sbx` / `Docker`.
 * SET-47: each non-host selection explains itself in ITS row — the command the
 * operator must run is rendered as code — instead of in one block after the
 * table. SET-48: the segments are the shared radio-group primitive, so arrow
 * keys move the choice and the focus together.
 */
import { Fragment, type ReactNode, useEffect } from 'react';
import type { Manifest } from '../../../../manifest/types.js';
import {
  allowedBackends,
  BACKEND_CORE_PROVIDER,
  BACKEND_CORES,
  wantedBackends,
  type AgentBackends,
  type BackendCore,
  type CoreBackend,
} from '../../../../agent/backendChoices.js';
import type { BackendStatus } from '../../../../agent/effectiveBackend.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { SegmentedControl, type SegmentedOption } from '../primitives/SegmentedControl.js';
import { AgentCoreIcon } from './AgentCoreIcon.js';
import { providerLabel } from './presetDraft.js';

const NO_SANDBOX_NOTE = 'no sandbox yet';

/** The segment copy: `sbx` stays lowercase because that is the product's name. */
const BACKEND_TEXT: Readonly<Record<CoreBackend, string>> = {
  host: 'Host',
  sbx: 'sbx',
  docker: 'Docker',
};

function setCoreBackend(core: BackendCore, value: CoreBackend): (draft: Manifest) => Manifest {
  return (draft) => {
    const kept = Object.entries(draft.agentBackends ?? {}).filter(([key]) => key !== core);
    const entries = value === 'host' ? kept : [...kept, [core, value]];
    const manifest = { ...draft };
    delete manifest.agentBackends;
    return entries.length === 0 ? manifest : { ...manifest, agentBackends: Object.fromEntries(entries) as AgentBackends };
  };
}

/**
 * A backend's readiness for one row. A command inside backticks (`sbx login`)
 * renders as `<code>`; the split is pure React — never raw HTML.
 */
function statusNode(core: BackendCore, backend: 'sbx' | 'docker', status: BackendStatus | undefined): ReactNode {
  const testId = `backend-status-${core}`;
  if (status === undefined) {
    return <span className="field-help backend-status" data-testid={testId}>not checked</span>;
  }
  if (status.ok) {
    return <span className="field-help backend-status" data-testid={testId}>ready</span>;
  }
  return (
    <span className="backend-status is-error" data-testid={testId} role="alert">
      <span className="backend-status-name">{backend}: </span>
      {status.reason.split(/(`[^`]*`)/).map((part, index) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
          // The index keeps the key unique: a reason that starts and ends with a
          // command ('`sbx login`') splits into ['', '`sbx login`', ''] and the
          // two empty literal segments would otherwise share one key.
          <code key={`${testId}:${index}`}>{part.slice(1, -1)}</code>
        ) : (
          <Fragment key={`${testId}:${index}`}>{part}</Fragment>
        ),
      )}
    </span>
  );
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
      <div className="form-grid">
        {BACKEND_CORES.map((core) => {
          const allowed = allowedBackends(core);
          const current = backends?.[core] ?? 'host';
          const options: readonly SegmentedOption[] = allowed.map((value) => ({
            value,
            label: BACKEND_TEXT[value],
          }));
          return (
            <Fragment key={core}>
              <span className="field-label" id={`backend-label-${core}`}>
                <span className="backend-core">
                  <AgentCoreIcon provider={BACKEND_CORE_PROVIDER[core]} />
                  <span>{providerLabel(BACKEND_CORE_PROVIDER[core])}</span>
                </span>
              </span>
              <div className="field-control backend-control" data-testid={`backend-row-${core}`}>
                <SegmentedControl
                  labelId={`backend-label-${core}`}
                  value={current}
                  options={options}
                  disabled={allowed.length === 1}
                  onChange={(value) => edit(setCoreBackend(core, value as CoreBackend))}
                />
                {allowed.length === 1 ? <span className="field-help">{NO_SANDBOX_NOTE}</span> : null}
                {current === 'sbx' ? statusNode(core, 'sbx', status?.sbx) : null}
                {current === 'docker' ? statusNode(core, 'docker', status?.docker) : null}
              </div>
            </Fragment>
          );
        })}
      </div>
      <Button
        className="backend-recheck"
        variant="secondary"
        size="sm"
        onClick={() => send.checkBackends({ sbx: want.sbx, docker: want.docker })}
      >
        Re-check
      </Button>
    </div>
  );
}
