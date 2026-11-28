/**
 * The implementation graph's ONE ledger. The host ships `nodes` on the graph process's rows evidence (planner runs,
 * node runs and deferred nodes, ALREADY ordered oldest first); the webview renders them in order with no sections and
 * concatenates nothing (UI-R31). The DAG strip is the same workers as finished columns of chips the host laid out.
 *
 * A node row is minimal — glyph, id, status and age, plus the override, reason and action only when they exist. Its
 * details card (host-worded) opens on hover or keyboard focus of the row and of the Graph view chip.
 *
 * Which of the two the user is looking at is local view state (`InsideMemory`, per ticket, never persisted and never
 * sent to the host), so it survives every push and one ticket's choice never leaks into another.
 */
import type { GraphDagChip, GraphDagView, GraphNodeListRow } from '../../../model/inside/types.js';
import { InsideActionButton } from './InsideParts.js';
import { GraphNodeAge } from './InsideClocks.js';
import { GraphNodeCard, useNodeCard } from './GraphNodeCard.js';
import { useDagShown, useInsideScope } from './InsideMemory.js';
import { statusWord, withKeys } from './insideText.js';

/**
 * One ledger entry. A node run is minimal: the identity, visit, outcome and artifact list moved into the card, so
 * the row reads `✓ ssh-runner  completed · 18m`. Planner and deferred rows keep every fact they had.
 */
function GraphNodeEntry({ n, stage, id, index }: { readonly n: GraphNodeListRow; readonly stage: string; readonly id: string; readonly index: number }) {
  const node = n.entry === 'node';
  const card = useNodeCard(n.card);
  return (
    <div className="graph-entry">
      <div className="graph-node" {...card.triggerProps}>
        {/* The status word rides the glyph's accessible name; the raw node-run status is the row's own verdict text and stays visible as meta. */}
        <span className={`glyph ${n.displayStatus}`} role="img" aria-label={statusWord(n.displayStatus)} />
        <span className="graph-node-name">{n.nodeId}</span>
        <span className="graph-node-meta">{node ? n.status : `${n.nodeKind} · ${n.status}`}</span>
        <span className="graph-node-detail">
          {node ? null : n.identity ? <span className="graph-node-identity">{n.identity}</span> : null}
          {!node && n.visit ? <span className="graph-node-visit">{n.visit}</span> : null}
          <GraphNodeAge stage={stage} id={id} index={index} />
          {n.override ? <span className="graph-node-override">{n.override}</span> : null}
          {!node && n.outcome ? <span className="graph-node-fact">{n.outcome}</span> : null}
          {n.reason ? <span className="graph-node-reason">{n.reason}</span> : null}
        </span>
        {n.action ? (
          <span className="ev-tail">
            <InsideActionButton action={n.action} />
          </span>
        ) : null}
      </div>
      {!node && n.artifacts && n.artifacts.length ? <div className="graph-node-artifacts">{n.artifacts.join(' · ')}</div> : null}
      {card.open && n.card ? <GraphNodeCard card={n.card} id={card.cardId} triggerRef={card.triggerRef} onClose={card.close} /> : null}
    </div>
  );
}

export function GraphNodeList({ nodes, stage, id }: { readonly nodes: readonly GraphNodeListRow[]; readonly stage: string; readonly id: string }) {
  return (
    <div className="graph-nodes">
      {withKeys(nodes, (n) => `${n.entry}:${n.nodeRunId ?? ''}:${n.nodeId}`).map(([key, n], index) => (
        <GraphNodeEntry key={key} n={n} stage={stage} id={id} index={index} />
      ))}
    </div>
  );
}

/** One DAG chip; a node with a run carries the same details card as its ledger row. */
function GraphDagChipView({ chip }: { readonly chip: GraphDagChip }) {
  const card = useNodeCard(chip.card);
  return (
    <>
      <div className={`graph-dag-chip ${chip.displayStatus}`} {...card.triggerProps}>
        <span className={`glyph ${chip.displayStatus}`} role="img" aria-label={statusWord(chip.displayStatus)} />
        <span className="graph-dag-id">{chip.label}</span>
        <span className="graph-dag-state">{chip.state}</span>
      </div>
      {card.open && chip.card ? <GraphNodeCard card={chip.card} id={card.cardId} triggerRef={card.triggerRef} onClose={card.close} /> : null}
    </>
  );
}

export function GraphDag({ dag }: { readonly dag: GraphDagView }) {
  return (
    <div className="graph-dag" role="group" aria-label="Implementation graph" tabIndex={0}>
      <div className="graph-dag-strip">
        {dag.columns.flatMap((col, i) => [
          ...(i > 0 ? [<span className="graph-dag-link" aria-hidden="true" key={`link-${col.map((c) => c.id).join(',')}`} />] : []),
          <div className="graph-dag-col" key={`col-${col.map((c) => c.id).join(',')}`}>
            {col.map((c) => (
              <GraphDagChipView chip={c} key={c.id} />
            ))}
          </div>,
        ])}
        {dag.more ? <span className="graph-dag-more">{dag.more}</span> : null}
      </div>
    </div>
  );
}

/** The ledger / DAG switch: purely local, no host message. */
export function GraphViewToggle() {
  const { memory, ticketId } = useInsideScope();
  const shown = useDagShown();
  return (
    <div className="graph-view-bar">
      <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="toggle-graph-view" aria-pressed={shown ? 'true' : 'false'} onClick={() => memory.toggleDag(ticketId)}>
        Graph view
      </button>
    </div>
  );
}
