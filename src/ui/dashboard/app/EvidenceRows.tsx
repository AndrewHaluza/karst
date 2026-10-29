/**
 * The row-shaped evidence bodies: the generic rows (with the implementation graph when the host ships one), the
 * gates, the findings (with the repository scope chips) and the recovery history. Every string is the host's; this
 * file only lays it out.
 */
import { useCallback } from 'react';
import type { EvidenceRow, InsideProcessView, ProcessEvidenceView } from '../../../model/inside/types.js';
import type { GateStage } from '../../../store/ticketGates.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { EvAction, EvGlyph, EvTiming, PrState } from './EvidenceParts.js';
import { GraphDag, GraphNodeList, GraphViewToggle } from './EvidenceGraph.js';
import { useDagShown } from './InsideMemory.js';
import { ObjLink } from './InsideParts.js';
import { INSIDE_ACTION_TITLE, withKeys } from './insideText.js';

const rowKey = (r: EvidenceRow): string => r.label;

type Of<K extends ProcessEvidenceView['kind']> = Extract<ProcessEvidenceView, { kind: K }>;

export function EvidenceRows({ ev }: { readonly ev: ProcessEvidenceView }) {
  const shown = useDagShown();
  const rich = ev.kind === 'rows' ? ev : null;
  const hasDag = !!(rich?.dag && rich.dag.columns && rich.dag.columns.length);
  return (
    <>
      {rich?.nodes && rich.nodes.length ? (
        <>
          {hasDag ? <GraphViewToggle /> : null}
          {hasDag && shown && rich.dag ? <GraphDag dag={rich.dag} /> : <GraphNodeList nodes={rich.nodes} />}
        </>
      ) : null}
      {withKeys(ev.rows, rowKey).map(([key, r]) => (
        <div className="evidence-row" key={key}>
          <EvGlyph r={r} />
          <span className="ev-key">{r.label}</span>
          <span className="ev-detail">
            {r.detail || ''}
            <PrState state={r.prState} />
          </span>
          {r.action ? <EvAction r={r} /> : <EvTiming r={r} cls="ev-state" />}
        </div>
      ))}
    </>
  );
}

/** The recorded repository is its own column. A body whose rows name none (pre-v21 gate rows) drops the column instead of drawing it empty. */
export function EvidenceGates({ ev }: { readonly ev: Of<'gates'> }) {
  const hasRepo = ev.rows.some((r) => !!r.repo);
  return (
    <div className={`gates${hasRepo ? '' : ' no-repo'}`}>
      {withKeys(ev.rows, (r) => `${r.repo ?? ''}/${r.label}`).map(([key, r]) => (
        <div className={`gate-row${r.status === 'run' ? ' active' : ''}`} key={key}>
          <EvGlyph r={r} />
          {hasRepo ? <span className="gate-repo">{r.repo || ''}</span> : null}
          <span className="gate-name">{r.label}</span>
          <span className="gate-detail">{r.detail || ''}</span>
          <EvTiming r={r} cls="gate-state" />
        </div>
      ))}
    </div>
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
  return (
    <>
      {filter && filter.repos && filter.repos.length >= 2 ? <Scope filter={filter} stageKey={stageKey} /> : null}
      {ev.stall ? <StallSummary stall={ev.stall} /> : null}
      <div className="findings">
        {withKeys(ev.rows, (r) => `${r.label}/${r.detail ?? ''}/${r.location ?? ''}`).map(([key, r]) => (
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
