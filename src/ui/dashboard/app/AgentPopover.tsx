/**
 * The header's agent button and its switch popover. The popover stages a draft core / model / effort and does
 * nothing until the picker's "Switch agent" is clicked; the draft is a suggestion, never authority (the host re-validates
 * the `switch-agent` message). The shared agent identity picker is a vanilla runtime (`mountAgentPicker`), so it
 * is wrapped in one empty container React never reconciles children into. The open state lives in `Header`.
 */
import { memo, useLayoutEffect, useRef } from 'react';
import { Icon } from './Icon.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { agentName, RuntimeIcon } from './AgentIcon.js';
import { selectAgent, type AgentSlice } from './headerSlices.js';
import { useSlice } from './useSlice.js';
import type { DashboardSender } from './hostBridge.js';

interface PickerValue {
  readonly core: string;
  readonly model: string;
  readonly effort: string;
}
type MountPicker = (root: HTMLElement, opts: Record<string, unknown>) => unknown;

const pageMount = (): MountPicker | null => (globalThis as unknown as { mountAgentPicker?: MountPicker }).mountAgentPicker ?? null;
/** The route identity map the picker blob emits as the `AP_ROUTES` page global; absent = no route icons. */
const pageRoutes = (): Record<string, unknown> => (globalThis as unknown as { AP_ROUTES?: Record<string, unknown> }).AP_ROUTES ?? {};

interface PickerHandlers {
  readonly onCommit: (value: PickerValue) => void;
  readonly onCancel: () => void;
}

function pickerOptions(agent: AgentSlice, handlers: PickerHandlers): Record<string, unknown> {
  const sw = agent.switch;
  const s = agent.session;
  return {
    mode: 'staged',
    // The core list is registry-driven: the caller passes the registry order, the picker never hardcodes one.
    cores: (sw.cores || []).map((c) => ({ id: c.id, label: c.label || c.id, disabledReason: c.disabledReason })),
    currentCore: s.provider,
    catalog: sw.modelsByCore || sw.models || {},
    routes: pageRoutes(),
    recent: sw.recentByCore || {},
    value: { core: s.provider, model: s.modelId || '', effort: sw.effort || '' },
    // The inherit rows name the resolved defaults; picking one commits an empty model/effort (the host reads null as inherit).
    inherit: { model: sw.modelInheritLabel, effort: sw.effortInheritLabel },
    inheritCore: sw.inheritCore,
    showEffort: true,
    onCommit: handlers.onCommit,
    onCancel: handlers.onCancel,
  };
}

function SwitchForm({ agent, open, close }: { readonly agent: AgentSlice; readonly open: boolean; readonly close: () => void }) {
  const send: DashboardSender = useDashboardSend();
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef(agent);
  latest.current = agent;
  // `close` and `send` may change identity between renders; the mount effect must not re-run (it would drop the draft).
  const actions = useRef({ close, send });
  actions.current = { close, send };

  // Each open re-stages the picker from the current session. The picker owns the draft and the Switch / Cancel
  // buttons; the draft is a suggestion, never authority (the host re-validates the `switch-agent` message).
  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const mount = pageMount();
    if (!root || !mount) return;
    mount(
      root,
      pickerOptions(latest.current, {
        onCommit: ({ core, model, effort }) => {
          actions.current.close();
          // No requestId: the popover closes and the host owns the outcome (confirm modal + relaunch); a stale or
          // cancelled switch surfaces as a host toast or the next state push, never as an invented verdict (UI-R14/R31).
          actions.current.send.switchAgent(core as Parameters<DashboardSender['switchAgent']>[0], model || null, effort || null);
        },
        onCancel: () => actions.current.close(),
      }),
    );
  }, [open]);

  return (
    <div className="agentForm">
      {/* The UNIFIED agent picker (core + model + effort, staged mode), mounted by the runtime into this empty container. */}
      <div id="agentSwitchPicker" ref={rootRef} />
      <div className="fieldHelp">Agent core, model and effort changes are staged. Closing this menu takes no action.</div>
    </div>
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
