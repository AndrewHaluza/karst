/**
 * The header's second row (`#headerMeta`): the parent relations, the "Waits on" and "Unblocks" chip groups, then
 * one chip per capability model that differs from implementation. Hidden when both are empty. The row root is static in webview.html (the region
 * parity snapshot pins it without any data-* attribute), so its `hidden` is set on the node here.
 */
import { memo, useLayoutEffect, type ReactNode } from 'react';
import { useDashboardSend } from './DashboardAppContext.js';
import { RuntimeIcon } from './AgentIcon.js';
import { RegionPortal } from './RegionPortal.js';
import { selectMeta, type MetaSlice } from './headerSlices.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';
import { TicketRefChip } from '../../shared/TicketRefChip.js';

type Blocker = MetaSlice['blockers'][number];

function BlockerChip({ blocker }: { readonly blocker: Blocker }) {
  const send = useDashboardSend();
  const onPending = usePendingAction((requestId) => {
    if (blocker.ticketId !== null) send.openDependency(blocker.ticketId, requestId);
  });
  return (
    <TicketRefChip
      refView={blocker}
      showKey={true}
      link={true}
      dataAct="open-dependency"
      /* data-act="open-dependency" */
      onClick={(e) => {
        e.preventDefault();
        onPending(e);
      }}
    />
  );
}

/** Text parts joined by " · ", with each blocker chip an element between merged text runs (one text node per run). */
function relationNodes(meta: MetaSlice): { readonly nodes: ReactNode[]; readonly count: number } {
  const parts: string[] = [];
  if (meta.origin) parts.push(meta.origin);
  if (meta.subtaskParent) parts.push(`Sub-task of ${meta.subtaskParent.ref}`);
  if (meta.parent) parts.push(`Follow-up of ${meta.parent.ref}`);
  const nodes: ReactNode[] = [];
  let text = '';
  parts.forEach((part, i) => {
    if (i > 0) text += ' · ';
    text += part;
  });
  if (text) nodes.push(text);
  return { nodes, count: parts.length };
}

/** One labelled run of dependency chips: "Waits on" (incoming) or "Unblocks" (outgoing). */
function RefGroup({ label, refs }: { readonly label: string; readonly refs: readonly Blocker[] }) {
  return (
    <span className="refGroup" role="group" aria-label={label}>
      <span className="refGroupLabel">{label}</span>
      {refs.map((r) => (
        <BlockerChip key={`${r.kind}:${r.draftId ?? ''}:${r.ticketId ?? 'x'}:${r.label}`} blocker={r} />
      ))}
    </span>
  );
}

// Variant 2: list only roles whose provider/model differs from implementation (already on #agentButton), grouped by identity.
const CAP_ROLES = [
  ['uatTester', 'UAT'],
  ['review', 'Review'],
] as const;

interface CapGroup {
  readonly full: string;
  readonly provider: string;
  readonly model: string;
  readonly roles: string[];
}

function capabilityGroups(meta: MetaSlice): CapGroup[] {
  const impl = meta.capabilities.implementation;
  const groups = new Map<string, CapGroup>();
  for (const [key, roleLabel] of CAP_ROLES) {
    const id = meta.capabilities[key];
    if (!id || !id.provider || !id.model) continue;
    if (impl && impl.provider === id.provider && impl.model === id.model) continue;
    const full = `${id.provider}/${id.model}`;
    const group = groups.get(full) ?? { full, provider: id.provider, model: id.model, roles: [] };
    group.roles.push(roleLabel);
    groups.set(full, group);
  }
  return [...groups.values()];
}

const modelLabel = (meta: MetaSlice, provider: string, model: string): string =>
  (meta.modelsByCore[provider] ?? []).find((m) => m && m.id === model)?.label || model;

export const HeaderMeta = memo(function HeaderMeta() {
  const meta = useSlice(selectMeta);
  const relations = meta ? relationNodes(meta) : { nodes: [], count: 0 };
  const groups = meta ? capabilityGroups(meta) : [];
  const waitsOn = meta?.blockers ?? [];
  const unblocks = meta?.unblocks ?? [];
  const hidden = relations.count === 0 && groups.length === 0 && waitsOn.length === 0 && unblocks.length === 0;
  useLayoutEffect(() => {
    const row = document.getElementById('headerMeta');
    if (row) row.hidden = hidden;
  }, [hidden]);
  return (
    <RegionPortal id="headerMeta">
      <span id="parentRef" className="ticketParent" hidden={relations.count === 0}>
        {relations.nodes}
      </span>
      {waitsOn.length || unblocks.length ? (
        <span id="refGroups" className="refGroups">
          {waitsOn.length ? <RefGroup label="Waits on" refs={waitsOn} /> : null}
          {waitsOn.length && unblocks.length ? <span className="refDivider" aria-hidden="true" /> : null}
          {unblocks.length ? <RefGroup label="Unblocks" refs={unblocks} /> : null}
        </span>
      ) : null}
      <span id="capabilityLabels" className="capabilityLabels">
        {meta
          ? groups.map((g) => {
              const roles = g.roles.join(' · ');
              return (
                <span key={g.full} className="capChip" title={`${roles}: ${g.full}`}>
                  <span>{roles}</span>
                  <RuntimeIcon kind="agent" provider={g.provider} />
                  <span className="capModel">{modelLabel(meta, g.provider, g.model)}</span>
                </span>
              );
            })
          : null}
      </span>
    </RegionPortal>
  );
});
