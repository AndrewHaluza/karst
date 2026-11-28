/**
 * The row-shaped evidence bodies: the generic rows (with the implementation graph when the host ships one), the
 * gates, the findings (with the repository scope chips) and the recovery history. Every string is the host's; this
 * file only lays it out.
 */
import { useCallback, useState } from 'react';
import type { EvidenceRow, InsideProcessView, ProcessEvidenceView } from '../../../model/inside/types.js';
import type { GateStage } from '../../../store/ticketGates.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { StopNowConfirm } from './AutofixParts.js';
import { STEP_GATES_AGAIN } from '../../../model/inside/autofix.js';
import { EvAction, EvGlyph, EvOutput, EvTiming, PrState } from './EvidenceParts.js';
import { GraphDag, GraphNodeList, GraphViewToggle } from './EvidenceGraph.js';
import { Icon } from './Icon.js';
import { useDagShown } from './InsideMemory.js';
import { ObjLink } from './InsideParts.js';
import { INSIDE_ACTION_TITLE, withKeys } from './insideText.js';

const rowKey = (r: EvidenceRow): string => r.label;

type Of<K extends ProcessEvidenceView['kind']> = Extract<ProcessEvidenceView, { kind: K }>;

/** The list's element id, so the toggle's `aria-controls` points at the rows it expands. */
const listIdOf = (stage: string, id: string): string => `inside-${stage}-${id}-list`;

/**
 * The one control under a capped list. The host ships all rows and marks the ones past the cap `collapsed`; this
 * button flips local state and never posts: the reader is not asking the host for a different page.
 */
function CollapsedToggle({
  expanded,
  collapsedCount,
  controlsId,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly collapsedCount: number;
  readonly controlsId: string;
  readonly onToggle: () => void;
}) {
  return (
    <div className="evidence-overflow">
      <button
        type="button"
        className="k-btn k-btn--link k-btn--sm overflow-btn"
        data-act="toggle-evidence-rows"
        aria-expanded={expanded}
        aria-controls={controlsId}
        onClick={onToggle}
      >
        <Icon name="chevron-down" />
        {expanded ? 'Show fewer' : `Show ${collapsedCount} more`}
      </button>
    </div>
  );
}

/**
 * The Push row's two Deliver regions (T1018, T1403): the running pre-push gate is the progress line, a kept failure is
 * a gate failure. The row marker (`deliverGate`) tells a Deliver gate row from a per-repository push row of the same
 * status, so a running push row never claims the progress region.
 */
function deliverRegion(id: string, r: EvidenceRow): string | undefined {
  if (id !== 'push') return undefined;
  if (r.deliverDismiss) return 'deliver-gate-failures';
  return r.deliverGate && r.status === 'run' ? 'deliver-progress' : undefined;
}

export function EvidenceRows({ ev, stage, id }: { readonly ev: ProcessEvidenceView; readonly stage: string; readonly id: string }) {
  const shown = useDagShown();
  const [expanded, setExpanded] = useState(false);
  const rich = ev.kind === 'rows' ? ev : null;
  const hasDag = !!(rich?.dag && rich.dag.columns && rich.dag.columns.length);
  const lead = rich?.nodes && rich.nodes.length ? Math.min(rich.leadRows ?? 0, ev.rows.length) : 0;
  const collapsedCount = ev.rows.filter((r) => r.collapsed).length;
  const listId = listIdOf(stage, id);
  // Pair every row with its ORIGINAL index before the collapse filter: the live clock is read by index, so the row's
  // position in the host's array is what identifies it, never its position on screen.
  const indexed = withKeys(ev.rows, rowKey).map(([key, r], index) => ({ key, r, index }));
  const visible = expanded || collapsedCount === 0 ? indexed : indexed.filter(({ r }) => !r.collapsed);
  const renderRow = ({ key, r, index }: (typeof indexed)[number]) => (
    <div className="evidence-row" key={key} data-region={deliverRegion(id, r)}>
      <EvGlyph r={r} />
      <span className="ev-key" role="group" aria-label={r.label}>{r.label}</span>
      <span className="ev-detail">
        {r.detail || ''}
        <PrState state={r.prState} />
        <EvOutput text={r.output} />
      </span>
      <EvAction r={r} />
      <EvTiming r={r} cls="ev-state" stage={stage} id={id} index={index} />
    </div>
  );
  const body = (
    <>
      {visible.filter((v) => v.index < lead).map(renderRow)}
      {rich?.nodes && rich.nodes.length ? (
        <>
          {hasDag ? <GraphViewToggle /> : null}
          {hasDag && shown && rich.dag ? <GraphDag dag={rich.dag} /> : <GraphNodeList nodes={rich.nodes} stage={stage} id={id} />}
        </>
      ) : null}
      {visible.filter((v) => v.index >= lead).map(renderRow)}
      {id === 'autofix' ? <StopNowConfirm gatesRun={ev.rows.some((r) => r.label === STEP_GATES_AGAIN)} /> : null}
    </>
  );
  // No collapsed rows: the exact DOM of an uncapped body, so no existing baseline or layout path moves.
  if (collapsedCount === 0) return body;
  return (
    <>
      <div id={listId}>{body}</div>
      <CollapsedToggle expanded={expanded} collapsedCount={collapsedCount} controlsId={listId} onToggle={() => setExpanded((v) => !v)} />
    </>
  );
}

/** The recorded repository is its own column. A body whose rows name none (pre-v21 gate rows) drops the column instead of drawing it empty. */
export function EvidenceGates({ ev, stage, id }: { readonly ev: Of<'gates'>; readonly stage: string; readonly id: string }) {
  const hasRepo = ev.rows.some((r) => !!r.repo);
  const [expanded, setExpanded] = useState(false);
  const collapsedCount = ev.rows.filter((r) => r.collapsed).length;
  const listId = listIdOf(stage, id);
  // The original index travels with the row: a running row or a host re-run row after the cap must still read its own
  // clock from `rowTiming(stage, id, index)`.
  const indexed = withKeys(ev.rows, (r) => `${r.repo ?? ''}/${r.label}`).map(([key, r], index) => ({ key, r, index }));
  const visible = expanded || collapsedCount === 0 ? indexed : indexed.filter(({ r }) => !r.collapsed);
  return (
    <>
    {ev.caption ? <p className="gates-caption">{ev.caption}</p> : null}
    <div className={`gates${hasRepo ? '' : ' no-repo'}`} id={collapsedCount > 0 ? listId : undefined}>
      {visible.map(({ key, r, index }) => (
        <div className={`gate-row${r.status === 'run' ? ' active' : ''}`} key={key}>
          <EvGlyph r={r} />
          {hasRepo ? <span className="gate-repo">{r.repo || ''}</span> : null}
          <span className="gate-name">{r.label}</span>
          <span className={`gate-detail${r.status === 'wait' ? ' wait' : ''}`} title={r.status === 'wait' ? r.detail || undefined : undefined} aria-label={r.status === 'wait' ? r.detail || undefined : undefined}>{r.detail || ''}</span>
          <EvTiming r={r} cls="gate-state" stage={stage} id={id} index={index} />
        </div>
      ))}
    </div>
    {collapsedCount > 0 ? <CollapsedToggle expanded={expanded} collapsedCount={collapsedCount} controlsId={listId} onToggle={() => setExpanded((v) => !v)} /> : null}
    </>
  );
}

function Scope({ filter, stageKey }: { readonly filter: NonNullable<InsideProcessView['repoFilter']>; readonly stageKey: string }) {
  const send = useDashboardSend();
  // Selection is host-held (a snapshot answers with `repoFilter.selected`): the click only asks, with no local flip.
  const pick = useCallback((repo: string | null) => send.selectFindingsRepo(stageKey as GateStage, repo), [send, stageKey]);
  const chip = (label: string, value: string | null, active: boolean, title: string) => (
    <button
      type="button"
      className={`sev-scope-chip${active ? ' active' : ''}`}
      data-act="select-findings-repo"
      data-stage={stageKey}
      data-repo={value === null ? '' : value}
      aria-pressed={active ? 'true' : 'false'}
      title={title}
      key={value ?? ''}
      onClick={() => pick(value)}
    >
      {label}
    </button>
  );
  return (
    <div className="findings-scope" role="group" aria-label="Scope findings to one repository">
      {chip('All', null, filter.selected === null, 'Show findings from every repository')}
      {filter.repos.map((r) => chip(r.split('/').pop() || r, r, filter.selected === r, `Show only findings recorded against ${r}`))}
    </div>
  );
}

/**
 * Findings: ONE blueprint for both the Review findings and the UAT observations. The level is coloured from the
 * host's closed `severity` key (never from parsing the label, which is prose an agent wrote), and the location is the
 * row's own link rather than an "Open file" button beside inert text (UI-R09c). The level word stays visible, so
 * severity never rides colour alone (UI-R28).
 */
export function EvidenceFindings({ ev, p, stageKey }: { readonly ev: Of<'findings'>; readonly p: InsideProcessView; readonly stageKey: string }) {
  const filter = p.repoFilter;
  const [expanded, setExpanded] = useState(false);
  const collapsedCount = ev.rows.filter((r) => r.collapsed).length;
  const listId = listIdOf(stageKey, p.id);
  const rows = expanded || collapsedCount === 0 ? ev.rows : ev.rows.filter((r) => !r.collapsed);
  return (
    <>
      {filter && filter.repos && filter.repos.length >= 2 ? <Scope filter={filter} stageKey={stageKey} /> : null}
      {ev.stall ? <StallSummary stall={ev.stall} /> : null}
      <div className="findings" id={collapsedCount > 0 ? listId : undefined}>
        {withKeys(rows, (r) => `${r.label}/${r.detail ?? ''}/${r.location ?? ''}`).map(([key, r]) => (
          <div className="finding" key={key}>
            <span className={`sev${r.severity ? ` sev-${r.severity}` : ''}`}>{r.label}</span>
            <span className="finding-title">{r.detail || ''}</span>
            <span className="finding-loc">
              <ObjLink text={r.location} action={r.action} cls="file-link" title={INSIDE_ACTION_TITLE['open-file'] ?? ''} />
            </span>
            <span className="finding-time">{r.time || r.duration || ''}</span>
          </div>
        ))}
      </div>
      {collapsedCount > 0 ? <CollapsedToggle expanded={expanded} collapsedCount={collapsedCount} controlsId={listId} onToggle={() => setExpanded((v) => !v)} /> : null}
    </>
  );
}


/** Review only: which files keep drawing blocking findings, and how many findings recur, round over round. */
function StallSummary({ stall }: { readonly stall: NonNullable<Of<'findings'>['stall']> }) {
  return (
    <div className="findings-stall" role="note">
      <strong>{stall.stalled ? 'Review stalled' : 'Findings repeating'}</strong>
      {stall.files.map((f) => (
        <span className="findings-stall-file" key={f.file}>
          {f.file}: {f.roundsHit} rounds
        </span>
      ))}
      {stall.repeatedIdentities > 0 ? (
        <span className="findings-stall-repeat">{stall.repeatedIdentities} repeated</span>
      ) : null}
    </div>
  );
}
