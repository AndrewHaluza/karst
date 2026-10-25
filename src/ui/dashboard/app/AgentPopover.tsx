/**
 * The header's agent button and its switch popover. The popover stages a draft core / model / effort and does
 * nothing until "Switch agent..." is clicked; the draft is a suggestion, never authority (the host re-validates
 * the `switch-agent` message). The shared agent identity picker is a vanilla runtime (`mountAgentPicker`), so it
 * is wrapped in one empty container React never reconciles children into. The open state lives in `Header`.
 */
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { agentName, RuntimeIcon } from './AgentIcon.js';
import { selectAgent, type AgentSlice } from './headerSlices.js';
import { useSlice } from './useSlice.js';
import type { DashboardSender } from './hostBridge.js';

interface Draft {
  readonly core: string | null;
  readonly model: string;
  readonly effort: string;
}
interface PickerValue {
  readonly core: string;
  readonly model: string;
  readonly effort: string;
}
type MountPicker = (root: HTMLElement, opts: Record<string, unknown>) => unknown;

const pageMount = (): MountPicker | null => (globalThis as unknown as { mountAgentPicker?: MountPicker }).mountAgentPicker ?? null;
const providerLabel = (provider: string): string =>
  (globalThis as unknown as { AGENT_PROVIDER_LABELS?: Record<string, string> }).AGENT_PROVIDER_LABELS?.[provider] ?? provider;
/** The route identity map the picker blob emits as the `AP_ROUTES` page global; absent = no route icons. */
const pageRoutes = (): Record<string, unknown> => (globalThis as unknown as { AP_ROUTES?: Record<string, unknown> }).AP_ROUTES ?? {};

const initialDraft = (agent: AgentSlice): Draft => ({
  core: agent.session.provider,
  model: agent.session.modelId || '',
  effort: agent.switch?.effort || '',
});

function pickerOptions(agent: AgentSlice, draft: Draft, onChange: (value: PickerValue) => void): Record<string, unknown> {
  const sw = agent.switch;
  const s = agent.session;
  return {
    cores: (sw.cores || []).map((c) => ({ id: c.id, label: c.label || c.id })),
    catalog: sw.modelsByCore || sw.models || {},
    routes: pageRoutes(),
    recent: sw.recentByCore || {},
    value: { core: draft.core || '', model: draft.model, effort: draft.effort },
    // The model/effort inherit rows describe the SETTINGS default core; the picker drops them once another core is
    // picked (an inherited Claude model is not a thing opencode can inherit).
    inheritCore: sw.inheritCore || '',
    inherit: {
      core: `Inherit (settings: ${providerLabel(s.provider)})`,
      model: s.modelId ? `Inherit (settings: ${sw.modelInheritLabel || ''})` : 'No default (agent picks)',
      effort: sw.effortInheritLabel || 'No effort (agent picks)',
    },
    showEffort: true,
    onChange,
  };
}

function SwitchForm({ agent, open, close }: { readonly agent: AgentSlice; readonly open: boolean; readonly close: () => void }) {
  const send: DashboardSender = useDashboardSend();
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef(agent);
  latest.current = agent;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(agent));

  // Each open re-stages the draft from the current session and re-configures the (idempotent) picker.
  useLayoutEffect(() => {
    if (!open) return;
    const fresh = initialDraft(latest.current);
    setDraft(fresh);
    const root = rootRef.current;
    const mount = pageMount();
    if (!root || !mount) return;
    // Close any select-shells a previous opening left open.
    root.querySelectorAll('.select-shell.is-open').forEach((shell) => {
      shell.classList.remove('is-open');
      shell.querySelector('.dropdown, .model-pop')?.classList.remove('open');
    });
    mount(
      root,
      pickerOptions(latest.current, fresh, ({ core, model, effort }) => setDraft({ core: core || null, model: model || '', effort: effort || '' })),
    );
  }, [open]);

  const s = agent.session;
  const changed = draft.core !== s.provider || (draft.model || null) !== (s.modelId || null) || (draft.effort || null) !== (s.effort || null);
  const onSwitch = (): void => {
    if (!changed) return;
    close();
    // No requestId: the popover closes and the host owns the outcome (confirm modal + relaunch); a stale or cancelled
    // switch surfaces as a host toast or the next state push, never as an invented verdict (UI-R14/R31).
    send.switchAgent(
      draft.core as Parameters<DashboardSender['switchAgent']>[0],
      draft.model || null,
      draft.effort || null,
    );
  };
  return (
    <>
      <div className="agentForm">
        {/* The UNIFIED agent identity picker (core + model + effort), mounted by the runtime into this empty container. */}
        <div id="agentSwitchPicker" ref={rootRef} />
        <div className="fieldHelp">Agent core, model and effort changes are staged. Closing this menu takes no action.</div>
      </div>
      <div className="popActions">
        <button id="switchBtn" type="button" className="k-btn k-btn--primary" disabled={!changed} onClick={onSwitch}>
          Switch agent…
        </button>
      </div>
    </>
  );
}

export const AgentPopover = memo(function AgentPopover({
  open,
  onToggle,
  close,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly close: () => void;
}) {
  const agent = useSlice(selectAgent);
  const session = agent?.session;
  const st = agent?.agentState ?? 'idle';
  const canSwitch = session ? session.canSwitch : true;
  return (
    <div className="agentWrap">
      <button
        id="agentButton"
        type="button"
        className="agentButton"
        aria-expanded={open ? 'true' : 'false'}
        aria-haspopup="dialog"
        title={canSwitch ? 'Switch the agent core and model' : 'Cannot switch while a fix recovery is running'}
        disabled={!canSwitch}
        onClick={onToggle}
      >
        <span id="agentCore" className="k-agent-core">
          {session ? (
            <span className="agentbadge">
              <RuntimeIcon kind="agent" provider={session.provider} />
              <span className="agentname">{agentName(session.provider)}</span>
            </span>
          ) : null}
        </span>
        <span aria-hidden="true" className="agentSep">
          ·
        </span>
        <span id="agentModel" className="agentMeta">
          {session?.modelLabel}
        </span>
        <span className="agentLive">
          <span id="agentDot" className={`agentLiveDot ${st}`} />
          <span id="agentLiveText">{st}</span>
        </span>
        <Icon name="chevron-down" />
      </button>
      <div id="agentPopover" className={open ? 'popover agentPopover open' : 'popover agentPopover hidden'} role="dialog" aria-label="Switch active agent">
        {agent ? <SwitchForm agent={agent} open={open} close={close} /> : null}
      </div>
    </div>
  );
});
