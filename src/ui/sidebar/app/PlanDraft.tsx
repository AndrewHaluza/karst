/**
 * A Planning draft (level-2 treeitem): its host-built `D<id>` (the
 * planning_proposals row id agents refer to) before the title. Pending ones
 * carry Approve / Discard; accepted ones stay, struck through, linked to the
 * ticket they became. Dependencies render as a wrapping chip row below
 * (UI-R43/R44: chips wrap, never truncate the id).
 */
import type { DepStatus, PlanningProposalRow } from '../state.js';
import { ActButton } from './action.js';
import { GLYPH_WORD } from './format.js';
import { Icon } from './Icon.js';
import { IconAct } from './IconAct.js';
import { acceptedTicketId, draftActions, type PlanAction } from './planModel.js';

/** The control for one tree-item action: an icon button, or the accepted draft's ticket link. */
export function PlanControl({ action }: { readonly action: PlanAction }) {
  const meta = { 'data-label': action.label };
  const primary = action.primary ? { 'data-primary': '1' } : {};
  if (action.kind === 'link') {
    return (
      <ActButton spec={action.spec} className="pt-link" tabIndex={-1} {...primary} {...meta} aria-label={action.aria} title={action.aria}>
        {action.text}
      </ActButton>
    );
  }
  // `tabindex=-1`: the treeitem owns the tab stop; keyboard users reach every
  // action through Enter and Shift+F10.
  return (
    <IconAct spec={action.spec} label={action.aria} tabIndex={-1} {...primary} {...meta}>
      <Icon name={action.icon} />
    </IconAct>
  );
}

/**
 * One chip per dependency: a status marker (the shared g-* tint, never colour
 * alone — the visible text states the kind) + the identifier, which is the link
 * (UI-R09c). Ticket/done chips open the dashboard; a draft chip focuses its
 * target card (handled by the tree).
 */
function DepChip({ dep }: { readonly dep: DepStatus }) {
  const glyph = dep.glyph && GLYPH_WORD[dep.glyph] ? dep.glyph : 'gray';
  const dot = <span className={`pt-dep-dot g-${glyph}`} aria-hidden="true" />;
  if (dep.kind === 'draft') {
    return (
      <button type="button" className="pt-dep" tabIndex={-1} data-dep-draft={Number(dep.id)} aria-label={`${dep.label}, draft pending`}>
        {dot}
        <span>{dep.label}</span>
      </button>
    );
  }
  const stage = dep.kind === 'ticket' && dep.stage ? ` · ${dep.stage}` : '';
  const name =
    dep.kind === 'done'
      ? `${dep.label}, ticket ${dep.ticketLabel} done`
      : `${dep.label}, ticket ${dep.ticketLabel} in ${dep.stage || 'progress'}`;
  return (
    <ActButton spec={{ act: 'open-dashboard', id: Number(dep.ticketId) }} className="pt-dep" tabIndex={-1} aria-label={name}>
      {dot}
      <span>{`${dep.label}→${dep.ticketLabel}${stage}`}</span>
    </ActButton>
  );
}

function Deps({ draft }: { readonly draft: PlanningProposalRow }) {
  const deps = draft.dependsOnStatus || [];
  if (!deps.length) return null;
  return (
    <div className="pt-deps-row">
      <span>needs</span>
      {deps.map((x) => (
        <DepChip key={`${x.kind}${x.id}`} dep={x} />
      ))}
    </div>
  );
}

/** A dependency the host pruned because its target was discarded: the card shows the edge was lost. Pending only. */
function Dropped({ draft }: { readonly draft: PlanningProposalRow }) {
  const dropped = draft.droppedLabels || [];
  if (!dropped.length) return null;
  const text = dropped.join(', ') + (dropped.length === 1 ? ' was discarded' : ' were discarded');
  return <span className="pt-deps pt-deps--warn" title={text}>{text}</span>;
}

/** Host warnings on the draft's constraints (unknown key/commit, no design rule). Pending only; full text is the tooltip. */
function Warnings({ draft }: { readonly draft: PlanningProposalRow }) {
  const ws = (draft.warnings || []).map((w) => String(w));
  if (!ws.length) return null;
  const label = ws.length === 1 ? ws[0] : `${ws.length} constraint warnings`;
  return <span className="pt-deps pt-deps--warn pt-cwarn" title={ws.join('; ')}>{label}</span>;
}

export function PlanDraft({ draft, tabIndex }: { readonly draft: PlanningProposalRow; readonly tabIndex: 0 | -1 }) {
  const node = `d${Number(draft.id)}`;
  if (draft.status === 'accepted') {
    const has = acceptedTicketId(draft) !== null;
    const label = has
      ? `${draft.idLabel} ${draft.title}, accepted as ticket ${draft.ticketIdLabel}`
      : `${draft.idLabel} ${draft.title}, accepted`;
    return (
      <div role="treeitem" aria-level={2} className="pt-l2 pt-accepted" data-node={node} tabIndex={tabIndex} aria-label={label}>
        <div className="pt-row" title={label}>
          <Icon name="circle-check" size={14} cls="pt-icon pt-c-passed" />
          <span className="pt-label">{draft.idLabel} {draft.title}</span>
          {draftActions(draft).map((a) => <PlanControl key={a.key} action={a} />)}
        </div>
        <Deps draft={draft} />
      </div>
    );
  }
  const label = `${draft.idLabel} ${draft.title}, needs review`;
  return (
    <div role="treeitem" aria-level={2} className="pt-l2" data-node={node} tabIndex={tabIndex} aria-label={label}>
      <div className="pt-row" title={label}>
        <Icon name="file-text" size={14} cls="pt-icon pt-c-attention" />
        <span className="pt-label">{draft.idLabel} {draft.title}</span>
        <Dropped draft={draft} />
        <Warnings draft={draft} />
        <span className="pt-actions">
          {draftActions(draft).map((a) => <PlanControl key={a.key} action={a} />)}
        </span>
      </div>
      <Deps draft={draft} />
    </div>
  );
}
