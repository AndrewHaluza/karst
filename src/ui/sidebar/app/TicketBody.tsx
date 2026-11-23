/**
 * The expanded row's mini-dashboard (peek.ts): one card. A headline (state dot,
 * state word, age, attempt, tools), a few quiet fact lines (gates, PRs, paused
 * note, agent, where) and at most one amber action strip. Archived rows keep
 * their labeled restore/delete pair instead. All of it is host-derived (UI-R31)
 * — the view phrases no domain state, it only formats the ISO times.
 */
import type { RailCta } from '../../../model/railNeeds.js';
import { GLYPH_WORD } from '../../../model/glyph.js';
import type { PeekNext, TicketPeek } from '../peek.js';
import type { TicketRow } from '../state.js';
import { ActButton, type ActionSpec } from './action.js';
import { AgentIdentity, Icon } from './Icon.js';
import { activeText, GLYPH_STATUS, metaLine, sinceText, whereLine } from './format.js';
import { Status } from '../../shared/Status.js';
import { useSidebar } from './SidebarContext.js';
import { TicketTools } from './TicketTools.js';

/** The strip button for a rail cta, or null when the cta has none (`open-session`). */
export function ctaSpec(cta: RailCta, id: number): { spec: ActionSpec; label: string } | null {
  switch (cta.kind) {
    case 'ship-confirm':
      return { spec: { act: 'ship-ticket', id }, label: 'Confirm ship' };
    case 'retry-ship':
      return { spec: { act: 'retry-ship', id }, label: 'Retry ship' };
    case 'merge':
      return { spec: { act: 'merge-pr', id, repo: cta.repo }, label: 'Merge' };
    case 'resolve-conflicts':
      return { spec: { act: 'resolve-conflicts', id, repo: cta.repo }, label: 'Resolve' };
    case 'merge-panel':
    case 'resolve-panel':
    case 'graph-panel':
      return { spec: { act: 'open-dashboard', id }, label: 'Open dashboard' };
    case 'open-session':
      return null;
  }
}

/** The rail cta tone: ready-to-ship and merge are routine, so they wear the sunken wash (SB-10). */
function ctaTone(cta: RailCta): 'attention' | 'neutral' {
  return cta.kind === 'ship-confirm' || cta.kind === 'merge' || cta.kind === 'merge-panel' ? 'neutral' : 'attention';
}

/** The one action strip: the rail's detail and its button, or the peek-only CI strip. */
function ActionStrip({ peek, row }: { readonly peek: TicketPeek; readonly row: TicketRow }) {
  const id = row.ticketId;
  const needs = peek.needs;
  if (needs) {
    const btn = ctaSpec(needs.cta, id);
    // A detail that only repeats the headline adds nothing (RD-7).
    const repeat = needs.detail.trim().toLowerCase() === peek.title.trim().toLowerCase();
    return (
      <div className={`peek-strip ${ctaTone(needs.cta)}`}>
        {repeat ? null : <span className="peek-strip-text">{needs.detail}</span>}
        {btn ? (
          <ActButton spec={btn.spec} className="k-btn k-btn--primary" title={btn.label}>
            {btn.label}
          </ActButton>
        ) : null}
      </div>
    );
  }
  const next: PeekNext | null = peek.next;
  if (next && next.kind === 'send-ci-failure') {
    return (
      <div className="peek-strip attention">
        <span className="peek-strip-text">CI is failing</span>
        <ActButton spec={{ act: next.kind, id }} className="k-btn k-btn--primary" title={next.label}>
          {next.label}
        </ActButton>
      </div>
    );
  }
  return null;
}

function Headline({ peek, row, sessVerb }: { readonly peek: TicketPeek; readonly row: TicketRow; readonly sessVerb: string }) {
  const { now } = useSidebar();
  const age = sinceText(peek.since, now);
  const glyph = peek.tone || row.glyph;
  return (
    <div className="peek-head">
      <div className="peek-copy">
        <Status kind={GLYPH_STATUS[glyph]} label={GLYPH_WORD[glyph]} />
        <span className="peek-title">{peek.title}</span>
        {age ? <span className="peek-age">{age}</span> : null}
        {peek.attempt && peek.attempt > 1 ? <span className="peek-attempt">attempt {peek.attempt}</span> : null}
      </div>
      <div className="peek-tools">
        <TicketTools row={row} sessVerb={sessVerb} />
      </div>
    </div>
  );
}

function PeekRepos({ repos }: { readonly repos: NonNullable<TicketPeek['repos']> }) {
  return (
    <div className="peek-line peek-repos">
      {repos.map((r) => (
        <span className="peek-repo" key={r.repo}>
          {r.number != null ? `#${r.number} ` : ''}
          {r.repo} · <span className={`peek-repo-state ${r.state}`}>{r.state}</span>
        </span>
      ))}
    </div>
  );
}

function AgentLine({ agent }: { readonly agent: NonNullable<TicketPeek['agent']> }) {
  const { now } = useSidebar();
  const active = activeText(agent.activeAt, now);
  const tail = [agent.activity, active].filter(Boolean).join(' · ');
  return (
    <div className="peek-line peek-agentline">
      <AgentIdentity provider={agent.provider} model={agent.model} />
      {tail ? <span className="peek-agent-tail">· {tail}</span> : null}
    </div>
  );
}

/** The graph roles a graph ticket launches: host-resolved (UI-R31), one line per role with its source. */
function GraphRoles({ roles }: { readonly roles: NonNullable<TicketRow['graphRoles']> }) {
  return (
    <>
      {roles.map((r) => (
        <div className="peek-line peek-graph-role" key={r.role} data-graph-role={r.role}>
          <span className="peek-graph-name">{r.role}</span> {r.text} <span className="peek-graph-source">({r.source})</span>
        </div>
      ))}
    </>
  );
}

/** Captured-artifact count (artifact store): a chip that opens the dashboard. Absent at zero. */
function ArtifactsChip({ row }: { readonly row: TicketRow }) {
  if (!row.artifacts) return null;
  const n = Number(row.artifacts);
  return (
    <ActButton spec={{ act: 'open-dashboard', id: Number(row.ticketId) }} className="peek-artifacts" title="Open the dashboard to browse captured artifacts">
      {n} artifact{n === 1 ? '' : 's'}
    </ActButton>
  );
}

/** The where line plus the artifacts chip; a shipped ticket adds its small follow-up button. */
function WhereLine({ peek, row }: { readonly peek: TicketPeek; readonly row: TicketRow }) {
  const where = whereLine(row);
  const followUp = peek.next && peek.next.kind === 'create-follow-up' ? peek.next : null;
  if (!where && !row.artifacts && !followUp) return null;
  return (
    <div className="peek-line peek-where">
      {where ? <span className="peek-where-text">{where}</span> : null}
      <ArtifactsChip row={row} />
      {followUp ? (
        <ActButton spec={{ act: followUp.kind, id: row.ticketId }} className="k-btn k-btn--secondary peek-followup" title={followUp.label}>
          {followUp.label}
        </ActButton>
      ) : null}
    </div>
  );
}

/** Archived rows keep their labeled restore/delete pair — the live toolbar only exists for active rows. */
function ArchivedBar({ row }: { readonly row: TicketRow }) {
  return (
    <div className="actions">
      <ActButton spec={{ act: 'unarchive', id: row.ticketId }} className="k-btn k-btn--secondary" title="Restore ticket to the active list">
        <Icon name="history" /> Unarchive
      </ActButton>
      <ActButton spec={{ act: 'delete', id: row.ticketId }} className="k-btn k-btn--danger" title="Delete ticket permanently">
        <Icon name="trash" /> Delete
      </ActButton>
    </div>
  );
}

export function TicketBody({ row, sessVerb }: { readonly row: TicketRow; readonly sessVerb: string }) {
  const peek = row.peek;
  const meta = metaLine(row);
  return (
    <div className="body">
      {/* The row title lives in a fixed cell and ends in an ellipsis; the expanded
          body prints it whole, wrapped, on its first line (UI-R44, SB-5). */}
      {row.label ? <div className="peek-fullname">{row.label}</div> : null}
      {!row.archived && peek && (
        <div className="peek">
          <Headline peek={peek} row={row} sessVerb={sessVerb} />
          <div className="peek-facts">
            {peek.gates ? <div className={`peek-line peek-gates ${peek.gates.tone}`}>{peek.gates.text}</div> : null}
            {peek.repos && peek.repos.length ? <PeekRepos repos={peek.repos} /> : null}
            {peek.pausedNote ? <div className="peek-line peek-paused">{peek.pausedNote}</div> : null}
            {peek.agent && peek.agent.provider ? <AgentLine agent={peek.agent} /> : null}
            {row.graphRoles && row.graphRoles.length ? <GraphRoles roles={row.graphRoles} /> : null}
            <WhereLine peek={peek} row={row} />
          </div>
          <ActionStrip peek={peek} row={row} />
        </div>
      )}
      {row.archived && meta ? <div className="meta">{meta}</div> : null}
      {row.archived ? <ArchivedBar row={row} /> : null}
    </div>
  );
}
