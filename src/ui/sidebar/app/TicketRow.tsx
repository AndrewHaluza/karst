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
import { Icon, KarstMark } from './Icon.js';
import { IconAct } from './IconAct.js';
import { MenuTrigger } from './MenuTrigger.js';
import { AUTOSTART_WORD, GLYPH_WORD, MAX_SUBTASK_INDENT, relTime } from './format.js';
import { useSidebar } from './SidebarContext.js';
import { TicketBody } from './TicketBody.js';

export interface TicketRowProps {
  readonly row: Row;
  readonly compact?: boolean;
  readonly time?: boolean;
  readonly older?: boolean;
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
  const label = `${collapsed ? 'Show' : 'Hide'} ${count} nested sub-task${count === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      className="k-iconbtn subchev"
      data-collapse={row.ticketId}
      aria-expanded={!collapsed}
      aria-label={label}
      title={label}
      onClick={() => toggleSubtree(row.ticketId)}
    >
      <Icon name={collapsed ? 'layout-list' : 'list-tree'} />
    </button>
  );
}

/** The collapsed hover strip: Spin / Terminal + the "⋯" trigger (archived rows: Restore / Delete). */
function HoverStrip({ row, sessVerb }: { readonly row: Row; readonly sessVerb: string }) {
  const id = row.ticketId;
  return (
    <span className="rowacts">
      {row.archived ? (
        <>
          <IconAct spec={{ act: 'unarchive', id }} label="Restore ticket to the active list"><Icon name="history" /></IconAct>
          <IconAct spec={{ act: 'delete', id }} label="Delete ticket permanently" danger><Icon name="trash" /></IconAct>
        </>
      ) : (
        <>
          <IconAct spec={{ act: 'spin', id }} label="Spin up worktree and dev servers"><Icon name="player-play" /></IconAct>
          <IconAct spec={{ act: 'open-session', id }} label={`${sessVerb} session`}><Icon name="terminal-2" /></IconAct>
          <MenuTrigger row={row} />
        </>
      )}
    </span>
  );
}

export function TicketRow({ row, compact = false, time = false, older = false }: TicketRowProps) {
  const { openIds, toggleOpen } = useSidebar();
  const isOpen = openIds.has(row.ticketId);
  // A restored snapshot can predate stageLabel, so fall back rather than render an empty pill.
  const stageText = row.stageLabel || row.description || '—';
  // The chip states the STAGE (colored by the shared stg-* token); the full phrase is the tooltip.
  // `autostart` is host-derived (UI-R31): a sub-task waiting at scope reads "Queued"/"Starting".
  const stageChip = (row.autostart ? AUTOSTART_WORD[row.autostart] : undefined) || row.stageChip || stageText;
  const stageClass = row.stageClass || 'stg-unknown';
  // The session button states which of the two it does — "Continue" or "Start".
  const sessVerb = row.sessionAction?.label || 'Start';
  const glyphWord = GLYPH_WORD[row.glyph] || 'Unknown';
  const toggleLabel = isOpen ? 'Collapse ticket details' : 'Expand ticket details';
  const blockedBy = row.blockedBy || [];

  // Decorative content of the row's main click target — never another interactive
  // control (UI-R09). Completed rows swap the karst mark + status dot for a
  // check-in-ring (aria-hidden) and drop the stage pill; the check SHAPE is the
  // non-color carrier (UI-R28) and `g-<glyph>` keeps the shared status color.
  const content = (
    <>
      {compact ? (
        <span className={`glyph chk g-${row.glyph}`} aria-hidden="true"><Icon name="circle-check" size={14} /></span>
      ) : (
        <span className={`glyph g-${row.glyph}`} role="img" aria-label={glyphWord} title={row.description}>
          <KarstMark />
          <span className="sdot" aria-hidden="true" />
          <span className="sdot-spin" aria-hidden="true" />
        </span>
      )}
      <span className="k-id" title={`Ticket ${row.idLabel}`}>{row.idLabel}</span>
      <span className="name">{row.label}</span>
      {blockedBy.length ? (
        <span className="k-chip" title={`Blocked by ${blockedBy.join(', ')}`}>Blocked by {blockedBy.join(', ')}</span>
      ) : null}
      {row.subtaskParentKey && !row.subtaskDepth ? (
        <span className="parentref subtaskref" title={`Sub-task of ${row.subtaskParentKey}`}>⊂ {row.subtaskParentKey}</span>
      ) : row.parentKey ? (
        <span className="parentref" title={`Follow-up of ${row.parentKey}`}>↳ {row.parentKey}</span>
      ) : null}
      {compact ? (
        time ? <span className="time">{relTime(row.lastActiveAt)}</span> : null
      ) : (
        <span className={`stage ${stageClass}`} title={stageText}>{stageChip}</span>
      )}
    </>
  );

  const nest = row.subtaskDepth ? ` nest${Math.min(row.subtaskDepth, MAX_SUBTASK_INDENT)}` : '';
  const cls = `ticket${isOpen ? ' open' : ''}${row.archived ? ' arch' : ''}${row.isActive ? ' active' : ''}${compact ? ' done' : ''}${older ? ' older' : ''}${nest}`;
  const cloudCount = new Set(row.cloudSessions?.map((c) => c.provider)).size;
  return (
    <div className={cls} data-id={row.ticketId}>
      <div className="row" style={cloudCount ? ({ '--cloud-n': cloudCount } as CSSProperties) : undefined}>
        <Guides row={row} />
        <button
          type="button"
          className="k-iconbtn chev"
          data-toggle={row.ticketId}
          aria-expanded={isOpen}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => toggleOpen(row.ticketId)}
        >
          <Icon name="chevron-right" size={12} />
        </button>
        {/* Archived tickets have no dashboard action, so the wrapper is a plain, non-interactive span. */}
        {row.archived ? (
          <span className="rowopen">{content}</span>
        ) : (
          <ActButton spec={{ open: row.ticketId }} className="k-btn k-btn--link k-btn--row rowopen" title="Open ticket dashboard">
            {content}
          </ActButton>
        )}
        <SubtreeToggle row={row} />
        {row.cloudSessions?.length ? <CloudLinks sessions={row.cloudSessions} ticketId={row.ticketId} /> : null}
        {/* Only rendered while COLLAPSED — expanding moves the same quick actions into the body's tools. */}
        {isOpen ? null : <HoverStrip row={row} sessVerb={sessVerb} />}
      </div>
      <TicketBody row={row} sessVerb={sessVerb} />
    </div>
  );
}
