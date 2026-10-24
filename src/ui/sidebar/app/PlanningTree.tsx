/**
 * The Planning tree (VS Code TreeView pattern): sessions are level-1 treeitems,
 * their drafts level-2. One roving tabindex (`planFocus`) and the per-session
 * expanded choice (`planOpen`) are pure view state: they survive re-renders and
 * never post. Status colour is never alone — the word is in each item's
 * aria-label and tooltip (UI-R28).
 */
import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import type { PlanningRow } from '../state.js';
import { ActButton } from './action.js';
import { Icon } from './Icon.js';
import { PlanControl, PlanDraft } from './PlanDraft.js';
import { actionsForNode, planIsOpen, planStatus, sessionActions } from './planModel.js';
import { ds } from './runtime.js';
import { useSidebar } from './SidebarContext.js';

const itemsOf = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const ownRow = (item: HTMLElement): Element | null => item.querySelector(':scope > .pt-row');
const primaryOf = (item: HTMLElement): HTMLElement | null => ownRow(item)?.querySelector<HTMLElement>('[data-primary]') ?? null;

function Session({ plan, stop }: { readonly plan: PlanningRow; readonly stop: string | null }) {
  const { planOpen } = useSidebar();
  const drafts = plan.proposals || [];
  const st = planStatus(plan);
  const open = planIsOpen(plan, planOpen);
  const agent = ds.agentLabel(plan.agent.provider) + (plan.agent.model ? ` · ${plan.agent.model}` : '');
  const count = drafts.length === 1 ? '1 draft' : `${drafts.length} drafts`;
  // The host-built `P<id>` the terminal tab carries, so a session is the same
  // identity in the sidebar and in the terminal list.
  const label = `${plan.idLabel} ${plan.title}, ${st.word}, ${agent}, ${count}`;
  return (
    <div
      role="treeitem"
      aria-level={1}
      data-node={`s${plan.sessionId}`}
      tabIndex={stop === `s${plan.sessionId}` ? 0 : -1}
      aria-expanded={drafts.length ? open : undefined}
      aria-label={label}
    >
      <div className="pt-row" title={label}>
        <span className={`pt-twistie${drafts.length ? '' : ' leaf'}`} data-plan-toggle={plan.sessionId} data-expanded={open} aria-hidden="true">
          <Icon name="chevron-right" size={12} />
        </span>
        <span className={`pt-dot pt-dot--${st.tone}`} aria-hidden="true" />
        <span className="pt-label">{plan.idLabel} {plan.title}</span>
        {drafts.length ? <span className="pt-count" aria-hidden="true">{drafts.length}</span> : null}
        <span className="pt-actions">
          {sessionActions(plan).map((a) => <PlanControl key={a.key} action={a} />)}
        </span>
      </div>
      {drafts.length && open ? (
        <div role="group">
          {drafts.map((d) => (
            <PlanDraft key={d.id} draft={d} tabIndex={stop === `d${Number(d.id)}` ? 0 : -1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PlanningTree({ plans }: { readonly plans: readonly PlanningRow[] }) {
  const { planOpen, planFocus, setPlanFocus, setPlanOpen, collapseAllPlans, openMenu } = useSidebar();
  const tree = useRef<HTMLDivElement | null>(null);
  const reveal = useRef<string | null>(null);

  // The tab stop is the focused node when it is still on screen, else the first item.
  const nodes = plans.flatMap((p) => [
    `s${p.sessionId}`,
    ...((p.proposals || []).length && planIsOpen(p, planOpen) ? p.proposals.map((d) => `d${Number(d.id)}`) : []),
  ]);
  const stop = planFocus !== null && nodes.includes(planFocus) ? planFocus : (nodes[0] ?? null);

  const focusItem = (item: HTMLElement | null | undefined): void => {
    if (!item) return;
    setPlanFocus(item.dataset.node ?? null);
    item.focus();
  };

  const setExpanded = (item: HTMLElement, open: boolean): void => {
    const id = Number((item.dataset.node ?? '').slice(1));
    const p = plans.find((x) => x.sessionId === id);
    if (!p || !(p.proposals || []).length) return;
    setPlanOpen(p.sessionId, open);
    focusItem(item);
  };

  // The context menu lists every action of the item, in row order, reusing the shared context window.
  const openPlanMenu = (item: HTMLElement): void => {
    const node = item.dataset.node ?? '';
    const items = actionsForNode(node, plans).map((a) => ({ key: a.key, spec: a.spec, label: a.label, icon: a.icon }));
    if (items.length) openMenu(item, node, items);
  };

  // A draft-dependency chip: reveal the target draft card (expanding its session
  // first when collapsed) and focus it. Pure view state, never posts.
  const revealDraft = (id: number): void => {
    const node = `d${id}`;
    const present = tree.current?.querySelector<HTMLElement>(`[data-node="${node}"]`);
    if (present) {
      focusItem(present);
      present.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    const owner = plans.find((p) => (p.proposals || []).some((d) => Number(d.id) === id));
    if (!owner) return;
    reveal.current = node;
    setPlanOpen(owner.sessionId, true);
    setPlanFocus(node);
  };
  useLayoutEffect(() => {
    const node = reveal.current;
    if (!node) return;
    const target = tree.current?.querySelector<HTMLElement>(`[data-node="${node}"]`);
    if (!target) return;
    reveal.current = null;
    target.focus();
    target.scrollIntoView?.({ block: 'nearest' });
  });

  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const t = e.target as Element;
    const dep = t.closest<HTMLElement>('[data-dep-draft]');
    if (dep) {
      revealDraft(Number(dep.dataset.depDraft));
      return;
    }
    const toggle = t.closest<HTMLElement>('[data-plan-toggle]');
    if (toggle) {
      const item = toggle.closest<HTMLElement>('[role="treeitem"]');
      if (item) setExpanded(item, toggle.dataset.expanded !== 'true');
      return;
    }
    // A click on the row body (not on one of its controls) is its primary action.
    const row = t.closest('.pt-row');
    if (!row || t.closest('button')) return;
    const item = row.parentElement as HTMLElement;
    focusItem(item);
    primaryOf(item)?.click();
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    const item = (e.target as Element).closest<HTMLElement>('[role="treeitem"]');
    if (!item) return;
    e.preventDefault();
    focusItem(item);
    openPlanMenu(item);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const item = e.target as HTMLElement;
    if (!item.matches || !item.matches('[role="treeitem"]') || !tree.current) return;
    const items = itemsOf(tree.current);
    const at = items.indexOf(item);
    const level = item.getAttribute('aria-level');
    const exp = item.getAttribute('aria-expanded');
    let handled = true;
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') openPlanMenu(item);
    else if (e.key === 'ArrowDown') focusItem(items[at + 1]);
    else if (e.key === 'ArrowUp') focusItem(items[at - 1]);
    else if (e.key === 'Home') focusItem(items[0]);
    else if (e.key === 'End') focusItem(items[items.length - 1]);
    else if (e.key === 'ArrowRight') {
      if (exp === 'false') setExpanded(item, true);
      else if (exp === 'true') focusItem(item.querySelector<HTMLElement>('[role="treeitem"]'));
    } else if (e.key === 'ArrowLeft') {
      if (exp === 'true') setExpanded(item, false);
      else if (level === '2') focusItem(item.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
    } else if (e.key === 'Enter') primaryOf(item)?.click();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <>
      <div className="sec pt-sec" role="presentation">
        <span className="sec-name">Planning</span>
        <span className="sec-n">· {plans.length}</span>
        <span className="pt-sec-acts">
          <ActButton spec={{ act: 'plan-create' }} className="k-iconbtn" aria-label="Start planning session" title="Start planning session">
            <Icon name="plus" />
          </ActButton>
          <button
            type="button"
            className="k-iconbtn"
            data-plan-collapse-all="1"
            aria-label="Collapse all planning sessions"
            title="Collapse all"
            onClick={collapseAllPlans}
          >
            <Icon name="chevrons-up" />
          </button>
        </span>
      </div>
      <div className="ptree" role="tree" aria-label="Planning sessions" ref={tree} onClick={onClick} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
        {plans.map((p) => (
          <Session key={p.sessionId} plan={p} stop={stop} />
        ))}
      </div>
    </>
  );
}
