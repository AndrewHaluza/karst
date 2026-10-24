/**
 * Pure model for the Planning tree: session status, expansion default, and the
 * action descriptors that ONE list feeds both the row's icon buttons and its
 * context menu (the menu lists every action of the item, in row order).
 */
import type { PlanningProposalRow, PlanningRow } from '../state.js';
import type { ActionSpec } from './action.js';

export const pendingOf = (p: PlanningRow): PlanningProposalRow[] => (p.proposals || []).filter((d) => d.status !== 'accepted');

export interface PlanStatus {
  readonly tone: 'attention' | 'running' | 'passed' | 'pending';
  readonly word: string;
}

/** Session status, precedence yellow > blue > green > grey. `--k-failed` is reserved: no state maps to it yet. */
export function planStatus(p: PlanningRow): PlanStatus {
  const drafts = p.proposals || [];
  if (pendingOf(p).length) return { tone: 'attention', word: 'needs review' };
  if (p.live) return { tone: 'running', word: 'terminal live' };
  if (p.status === 'filed') return { tone: 'passed', word: 'filed' };
  if (drafts.length) return { tone: 'passed', word: 'all drafts accepted' };
  return { tone: 'pending', word: 'terminal not live' };
}

/** A session with pending drafts starts expanded until the user chooses otherwise. */
export function planIsOpen(p: PlanningRow, chosen: ReadonlyMap<number, boolean>): boolean {
  const c = chosen.get(p.sessionId);
  return c !== undefined ? c : pendingOf(p).length > 0;
}

/** One action of a tree item. `link` is the text link on an accepted draft; the rest are icon buttons. */
export interface PlanAction {
  readonly key: string;
  readonly spec: ActionSpec;
  /** The context-menu wording. */
  readonly label: string;
  /** The accessible name (and tooltip) of the row control. */
  readonly aria: string;
  /** Tabler icon name; '' for the link, which has no glyph. */
  readonly icon: string;
  readonly kind: 'icon' | 'link';
  /** The visible text of a `link`. */
  readonly text?: string;
  /** The action the row body (click / Enter) triggers. */
  readonly primary?: boolean;
}

export function sessionActions(p: PlanningRow): PlanAction[] {
  const plan = p.sessionId;
  const archived = p.status === 'archived';
  return [
    { key: 'open', spec: { act: 'plan-open', plan }, label: 'Open terminal', aria: `Open terminal: ${p.title}`, icon: 'terminal-2', kind: 'icon', primary: true },
    archived
      ? { key: 'unarchive', spec: { act: 'plan-unarchive', plan }, label: 'Unarchive', aria: `Unarchive ${p.title}`, icon: 'history', kind: 'icon' }
      : { key: 'archive', spec: { act: 'plan-archive', plan }, label: 'Archive', aria: `Archive ${p.title}`, icon: 'archive', kind: 'icon' },
  ];
}

/** The ticket id a draft became, or null while pending / not a finite number. */
export function acceptedTicketId(d: PlanningProposalRow): number | null {
  const tid = Number(d.ticketId);
  return d.ticketId != null && Number.isFinite(tid) ? tid : null;
}

export function draftActions(d: PlanningProposalRow): PlanAction[] {
  if (d.status === 'accepted') {
    const tid = acceptedTicketId(d);
    if (tid === null) return [];
    const label = `Open ticket ${d.ticketIdLabel}`;
    return [{ key: 'ticket', spec: { open: tid }, label, aria: label, icon: '', kind: 'link', text: String(d.ticketIdLabel ?? ''), primary: true }];
  }
  const proposal = Number(d.id);
  return [
    { key: 'review', spec: { act: 'plan-proposal-review', proposal }, label: 'Approve', aria: `Approve draft: ${d.title}`, icon: 'check', kind: 'icon' },
    { key: 'discard', spec: { act: 'plan-proposal-discard', proposal }, label: 'Discard', aria: `Discard draft: ${d.title}`, icon: 'x', kind: 'icon' },
  ];
}

/** The actions of a tree node (`s<sessionId>` / `d<proposalId>`), or [] when it is gone. */
export function actionsForNode(node: string, plans: readonly PlanningRow[]): PlanAction[] {
  const id = Number(node.slice(1));
  if (node.startsWith('s')) {
    const p = plans.find((x) => x.sessionId === id);
    return p ? sessionActions(p) : [];
  }
  for (const p of plans) {
    const d = (p.proposals || []).find((x) => Number(x.id) === id);
    if (d) return draftActions(d);
  }
  return [];
}
