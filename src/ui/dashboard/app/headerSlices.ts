/**
 * The slices of the host snapshot the header renders (`useSlice` needs module-level selectors). Each one is
 * structurally compared, so the 1 Hz full-snapshot push re-renders a header part only when its slice changed.
 */
import type { DashboardSnapshot } from './dashboardStore.js';
import type { DashboardState } from '../state.js';
import { ticketStatus, type StatusTone } from './ticketHead.js';

export interface IdentitySlice {
  readonly idLabel: string;
  readonly key: string;
  readonly title: string;
  readonly provider: string;
  readonly priority: string;
  readonly ticketUrl: string | null;
  readonly statusWord: string;
  readonly statusTone: StatusTone;
}

type Relation = { readonly ref: string } | null;
type Blocker = DashboardState['blockers'][number];
type Capability = { readonly provider: string; readonly model: string | null } | null | undefined;

export interface MetaSlice {
  readonly origin: string | null;
  readonly subtaskParent: Relation;
  readonly parent: Relation;
  readonly blockers: readonly Blocker[];
  readonly capabilities: { readonly implementation: Capability; readonly uatTester: Capability; readonly review: Capability };
  readonly modelsByCore: Readonly<Record<string, ReadonlyArray<{ readonly id: string; readonly label?: string }>>>;
}

export interface ControlsSlice {
  readonly canDetach: boolean;
  readonly canClose: boolean;
  readonly canReopen: boolean;
  readonly paused: boolean;
  readonly done: boolean;
  readonly ship: DashboardState['ship'];
  /** The host's block reason while the parent is parked `awaiting-subtask`, else null. */
  readonly subtaskWait: string | null;
}

export interface AgentSlice {
  readonly session: DashboardState['agentSession'];
  readonly agentState: string;
  readonly switch: DashboardState['agentSwitch'];
}

const statusFields = (s: DashboardState): { statusWord: string; statusTone: StatusTone } => {
  const { word, tone } = ticketStatus({ stageCurrent: s.stageCurrent, paused: s.paused, agentState: s.agentState });
  return { statusWord: word, statusTone: tone };
};

export const selectIdentity = (snapshot: DashboardSnapshot): IdentitySlice | null => {
  const s = snapshot.state;
  return s
    ? { idLabel: s.idLabel, key: s.key || '', title: s.title || '(untitled)', provider: s.provider ?? '', priority: (s.priority || '').trim(), ticketUrl: s.ticketUrl || null, ...statusFields(s) }
    : null;
};

export const selectMeta = (snapshot: DashboardSnapshot): MetaSlice | null => {
  const s = snapshot.state;
  if (!s) return null;
  const ids = s.capabilityIdentity ?? ({} as NonNullable<DashboardState['capabilityIdentity']>);
  return {
    origin: s.origin || null,
    subtaskParent: s.subtaskParent ? { ref: s.subtaskParent.ref } : null,
    parent: s.parent ? { ref: s.parent.ref } : null,
    blockers: s.blockers || [],
    capabilities: { implementation: ids.implementation, uatTester: ids.uatTester, review: ids.review },
    modelsByCore: (s.agentSwitch?.modelsByCore ?? {}) as MetaSlice['modelsByCore'],
  };
};

export const selectControls = (snapshot: DashboardSnapshot): ControlsSlice | null => {
  const s = snapshot.state;
  if (!s) return null;
  const blocked = s.currentStage?.blocked;
  return {
    canDetach: !!s.canDetachSubtask,
    canClose: !!s.canClose,
    canReopen: !!s.canReopen,
    paused: !!s.paused,
    done: s.stageCurrent === 'done',
    ship: s.ship || { kind: 'none' },
    subtaskWait: blocked && blocked.kind === 'awaiting-subtask' ? blocked.reason || '' : null,
  };
};

export const selectAgent = (snapshot: DashboardSnapshot): AgentSlice | null => {
  const s = snapshot.state;
  return s?.agentSession && s.agentSwitch ? { session: s.agentSession, agentState: s.agentState || 'none', switch: s.agentSwitch } : null;
};

export const selectBind = (snapshot: DashboardSnapshot): boolean => snapshot.bind;
export const selectGates = (snapshot: DashboardSnapshot): DashboardSnapshot['gateOptions'] => snapshot.gateOptions;
