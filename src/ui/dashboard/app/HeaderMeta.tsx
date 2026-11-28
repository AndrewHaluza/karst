/**
 * The header's second row (`#headerMeta`): the parent relations, then the "Waits on" and "Unblocks" chip groups.
 * Hidden when both are empty. The row root is static in webview.html (the region parity snapshot pins it without any
 * data-* attribute), so its `hidden` is set on the node here. The customized-model chips that used to end this row
 * moved behind the row-1 Models button (T1413); row 2 keeps only the relations.
 */
import { memo, useLayoutEffect, type ReactNode } from 'react';
import { useDashboardSend } from './DashboardAppContext.js';
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
  // No `origin` here: the planning session is the `P<n>` link in row 1 (T1400), not row-2 text.
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

export const HeaderMeta = memo(function HeaderMeta() {
  const meta = useSlice(selectMeta);
  const relations = meta ? relationNodes(meta) : { nodes: [], count: 0 };
  const waitsOn = meta?.blockers ?? [];
  const unblocks = meta?.unblocks ?? [];
  const hidden = relations.count === 0 && waitsOn.length === 0 && unblocks.length === 0;
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
    </RegionPortal>
  );
});
