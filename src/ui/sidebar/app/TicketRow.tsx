/**
 * One ticket row. `compact` switches to the completed-row treatment: check
 * indicator instead of the status glyph, muted title, no stage pill (the section
 * context already says "done") and — for Recently Done only — the relative
 * completion time. The expanded body, the hover actions and the open/active
 * marks are identical either way: selecting a completed ticket behaves exactly
 * like selecting a Current one.
 */
import type { CSSProperties } from 'react';
import type { TicketRow as Row } from '../state.js';
import { ActButton } from './action.js';
import { CloudLinks } from './CloudSessions.js';
import { Icon } from './Icon.js';
import { IconAct } from './IconAct.js';
import { HoverTools } from './TicketTools.js';
import { MenuTrigger } from './MenuTrigger.js';
import { PriorityChip } from './PriorityChip.js';
import { AUTOSTART_WORD, GLYPH_STATUS, MAX_SUBTASK_INDENT, relTime } from './format.js';
import { GLYPH_WORD } from '../../../model/glyph.js';
import { Status } from '../../shared/Status.js';
import { useSidebar } from './SidebarContext.js';
import { TicketBody } from './TicketBody.js';
import { stageWord as stageWordOf } from '../../shared/ticketRefView.js';
import { TicketRefs } from './TicketRefs.js';

export interface TicketRowProps {
  readonly row: Row;
  readonly compact?: boolean;
  readonly time?: boolean;
  readonly older?: boolean;
  /** The roving tab stop for the tree (SB-6): this row's node id holds it. */
  readonly stop?: string | null;
  readonly posInSet?: number;
  readonly setSize?: number;
}

/** Tree guides (decorative, aria-hidden): one span per ancestor indent slot, painted CSS-only. */
function Guides({ row }: { readonly row: Row }) {
  if (!row.subtaskDepth) return null;
  const slots = row.subtaskGuides || [];
  return (
    <span className="guides" aria-hidden="true">
      {slots.map((cont, i) => (
        <span
          // One span is always emitted per slot — even an off slot keeps its nth-child position.
          key={i}
          className={`guide ${i === slots.length - 1 ? (row.subtaskIsLast ? 'guide--elbow' : 'guide--tee') : cont ? 'guide--line' : 'guide--off'}`}
        />
      ))}
    </span>
  );
}

/** The collapse control for a row that HAS direct sub-tasks; its own state is `aria-expanded` (UI-R09b). */
function SubtreeToggle({ row }: { readonly row: Row }) {
  const { collapsedSubtrees, toggleSubtree } = useSidebar();
  const count = row.subtaskChildCount || 0;
  if (count <= 0) return null;
  const collapsed = collapsedSubtrees.has(row.ticketId);
  const label = collapsed ? 'Show subtasks' : 'Hide subtasks';
  return (
    <button
      type="button"
      className="k-iconbtn subchev"
      data-collapse={row.ticketId}
      tabIndex={-1}
      aria-expanded={!collapsed}
      aria-pressed={!collapsed}
      aria-label={label}
      title={label}
      onClick={() => toggleSubtree(row.ticketId)}
    >
      <Icon name={collapsed ? 'layout-list' : 'list-tree'} />
    </button>
  );
}

/** Archived rows keep their two labeled actions in flow: they have no More menu. */
function ArchivedStrip({ row }: { readonly row: Row }) {
  const id = row.ticketId;
  return (
    <span className="rowacts rowacts--static">
      <IconAct spec={{ act: 'unarchive', id }} label="Restore ticket to the active list" tabIndex={-1}><Icon name="history" /></IconAct>
      <IconAct spec={{ act: 'delete', id }} label="Delete ticket permanently" danger tabIndex={-1}><Icon name="trash" /></IconAct>
    </span>
  );
}

/**
 * The hover strip: Session / Pause-Resume only. It shows on hover or focus at
 * every width (SB-8, D860); the More menu is always in flow at the row end.
 */
function HoverStrip({ row, sessVerb }: { readonly row: Row; readonly sessVerb: string }) {
  return (
    <span className="rowacts">
      <HoverTools row={row} sessVerb={sessVerb} tabIndex={-1} />
    </span>
  );
}

export function TicketRow({ row, compact = false, time = false, older = false, stop = null, posInSet, setSize }: TicketRowProps) {
  const { openIds, toggleOpen } = useSidebar();
  const isOpen = openIds.has(row.ticketId);
  const node = `t${row.ticketId}`;
  // A restored snapshot can predate stageLabel, so fall back rather than render an empty pill.
  const stageText = row.stageLabel || row.description || '—';
  // The chip states the STAGE (colored by the shared stg-* token); the full phrase is the tooltip.
  // `autostart` is host-derived (UI-R31): a sub-task waiting at scope reads "Queued"/"Starting".
  const stageChip = (row.autostart ? AUTOSTART_WORD[row.autostart] : undefined) || row.stageChip || stageText;
  // A real stage gets the full/short word pair; a host word ("Queued", "Starting") stays plain text.
  const stageWord = !row.autostart && row.stageChip ? stageWordOf(row.stageChip) : null;
  const stageClass = row.stageClass || 'stg-unknown';
  // The session button states which of the two it does — "Continue" or "Start".
  const sessVerb = row.sessionAction?.label || 'Start';
  // A blue glyph read "Running"; while ship's PR CI runs the badge label is the
  // more exact name (@ui:STATUS-ICON-ONLY: no new visible status word).
  const glyphWord = row.stageLabel === 'CI running' ? 'CI running' : GLYPH_WORD[row.glyph] || 'Unknown';
  const toggleLabel = isOpen ? 'Collapse ticket details' : 'Expand ticket details';
  const blockedBy = row.blockedBy || [];

  // Decorative content of the row's main click target — never another interactive
  // control (UI-R09). A live row paints the shared `.k-status` marker (a shape per
  // state, UI-R28); completed rows swap it for a check-in-ring (aria-hidden) and
  // drop the stage pill; the check SHAPE is the non-color carrier and `g-<glyph>`
  // keeps the shared status colour.
  const content = (
    <>
      {compact ? (
        <span className={`glyph chk g-${row.glyph}`} aria-hidden="true"><Icon name="circle-check" size={14} /></span>
      ) : (
        <Status kind={GLYPH_STATUS[row.glyph]} label={glyphWord} />
      )}
      <span className="k-id" title={`Ticket ${row.idLabel}`}>{row.idLabel}</span>
      {row.priorityEditable ? <PriorityChip level={row.priority} source={row.prioritySource} provider={{ label: row.providerLabel, level: row.providerPriority }} /> : null}
      {/* The ellipsized copy is visual only; the 1x1 `.sr-only` sibling is what assistive tech reads, so a
          clipped title is announced once and is never silent truncation (@ui:UI-R44, SB-3). */}
      <span className="name" title={row.label}>
        <span aria-hidden="true">{row.label}</span>
        <span className="sr-only">{row.label}</span>
      </span>
      {row.subtaskParentKey && !row.subtaskDepth ? (
        <span className="parentref subtaskref" title={`Sub-task of ${row.subtaskParentKey}`}>⊂ {row.subtaskParentKey}</span>
      ) : row.parentKey ? (
        <span className="parentref" title={`Follow-up of ${row.parentKey}`}>↳ {row.parentKey}</span>
      ) : null}
      {compact ? (
        time ? <span className="time" title={row.lastActiveAt ?? undefined}>{relTime(row.lastActiveAt)}</span> : null
      ) : (
        stageWord ? (
          // One span, two words: CSS picks data-full or data-short by the host width (@ui:UI-R51).
          <span className={`stage ${stageClass}`} role="img" aria-label={stageText} title={stageText} data-full={stageWord.full} data-short={stageWord.short} />
        ) : (
          <span className={`stage ${stageClass}`} title={stageText}>{stageChip}</span>
        )
      )}
    </>
  );

  const nest = row.subtaskDepth ? ` nest${Math.min(row.subtaskDepth, MAX_SUBTASK_INDENT)}` : '';
  const cls = `ticket${isOpen ? ' open' : ''}${row.archived ? ' arch' : ''}${row.isActive ? ' active' : ''}${compact ? ' done' : ''}${older ? ' older' : ''}${nest}`;
  const cloudCount = new Set(row.cloudSessions?.map((c) => c.provider)).size;
  return (
    <div className={cls} data-id={row.ticketId}>
      <div
        className="row"
        style={cloudCount ? ({ '--cloud-n': cloudCount } as CSSProperties) : undefined}
        role="treeitem"
        data-node={node}
        tabIndex={stop === node ? 0 : -1}
        aria-level={(row.subtaskDepth || 0) + 1}
        aria-expanded={isOpen}
        aria-setsize={setSize}
        aria-posinset={posInSet}
      >
        <Guides row={row} />
        <button
          type="button"
          className="k-iconbtn chev"
          data-toggle={row.ticketId}
          tabIndex={-1}
          aria-expanded={isOpen}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => toggleOpen(row.ticketId)}
        >
          <Icon name="chevron-right" size={12} />
        </button>
        {/* Archived tickets have no dashboard action, so the wrapper is a plain, non-interactive span. */}
        {row.archived ? (
          <span className={`rowopen`}>{content}</span>
        ) : (
          <ActButton spec={{ open: row.ticketId }} className={`k-btn k-btn--link k-btn--row rowopen`} title="Open ticket dashboard" tabIndex={-1}>
            {content}
          </ActButton>
        )}
        <SubtreeToggle row={row} />
        {row.cloudSessions?.length ? <CloudLinks sessions={row.cloudSessions} ticketId={row.ticketId} tabIndex={-1} /> : null}
        {/* The always-visible More menu sits in flow at the row end (SB-8); the
            other quick tools are an overlay that shows on hover or focus at
            every width. Expanding moves the same quick actions into the body's tools. */}
        {isOpen ? null : row.archived ? (
          <ArchivedStrip row={row} />
        ) : (
          <>
            <HoverStrip row={row} sessVerb={sessVerb} />
            <span className="rowmore"><MenuTrigger row={row} tabIndex={-1} /></span>
          </>
        )}
      </div>
      {blockedBy.length ? <TicketRefs refs={blockedBy} /> : null}
      <TicketBody row={row} sessVerb={sessVerb} />
    </div>
  );
}
