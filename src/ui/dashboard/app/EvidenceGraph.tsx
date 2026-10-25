/**
 * The implementation graph's ONE ledger. The host ships `nodes` on the graph process's rows evidence (planner runs,
 * node runs and deferred nodes, ALREADY ordered oldest first); the webview renders them in order with no sections and
 * concatenates nothing (UI-R31). The DAG strip is the same workers as finished columns of chips the host laid out.
 *
 * Which of the two the user is looking at is local view state (`InsideMemory`, per ticket, never persisted and never
 * sent to the host), so it survives every push and one ticket's choice never leaks into another.
 */
import type { GraphDagView, GraphNodeListRow } from '../../../model/inside/types.js';
import { InsideActionButton } from './InsideParts.js';
import { useDagShown, useInsideScope } from './InsideMemory.js';
import { statusWord, withKeys } from './insideText.js';

export function GraphNodeList({ nodes }: { readonly nodes: readonly GraphNodeListRow[] }) {
  return (
    <div className="graph-nodes">
      {withKeys(nodes, (n) => `${n.entry}:${n.nodeRunId ?? ''}:${n.nodeId}`).map(([key, n]) => (
        <div className="graph-entry" key={key}>
          <div className="graph-node">
            {/* The status word rides the glyph's accessible name; the raw node-run status is the row's own verdict text and stays visible as meta. */}
            <span className={`glyph ${n.displayStatus}`} aria-label={statusWord(n.displayStatus)} />
            <span className="graph-node-name">{n.nodeId}</span>
            <span className="graph-node-meta">{`${n.nodeKind} · ${n.status}`}</span>
            <span className="graph-node-detail">
              {n.identity ? <span className="graph-node-identity">{n.identity}</span> : null}
              {n.visit ? <span className="graph-node-visit">{n.visit}</span> : null}
              {n.age ? <span className="graph-node-age">{n.age}</span> : null}
              {n.override ? <span className="graph-node-override">{n.override}</span> : null}
              {n.outcome ? <span className="graph-node-fact">{n.outcome}</span> : null}
              {n.reason ? <span className="graph-node-reason">{n.reason}</span> : null}
            </span>
            {n.action ? (
              <span className="ev-tail">
                <InsideActionButton action={n.action} />
              </span>
            ) : null}
          </div>
          {n.artifacts && n.artifacts.length ? <div className="graph-node-artifacts">{n.artifacts.join(' · ')}</div> : null}
        </div>
      ))}
    </div>
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
              <div className={`graph-dag-chip ${c.displayStatus}`} key={c.id}>
                <span className={`glyph ${c.displayStatus}`} aria-label={statusWord(c.displayStatus)} />
                <span className="graph-dag-id">{c.label}</span>
                <span className="graph-dag-state">{c.state}</span>
              </div>
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
