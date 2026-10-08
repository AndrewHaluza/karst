import { ticketLabel, type TicketWithStages } from '../../store/tickets.js';
import { ticketGlyph, currentStageStatus } from '../../model/ticketGlyph.js';
import { stageBadge } from '../../model/stageBadge.js';
import { stageColorClass } from '../../model/stagePalette.js';
import type { Glyph } from '../../model/glyph.js';
import { sessionAction, type SessionAction } from '../../agent/sessionAction.js';
import { resolveProvider } from '../../agent/registry.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { AgentDefaults } from '../../agent/agentPresets.js';
import { MAX_SUBTASK_DEPTH } from '../../workflow/stages/subtask.js';
import { subtaskAutostartPhase, type SubtaskAutostartPhase } from '../../model/subtask.js';
import type { TicketRelation } from '../../store/ticketRelations.js';

/** The PR fields the sidebar's meta line reads — a narrowed `PrView`. */
export interface SidebarPr {
  repo: string;
  number: number | null;
  url: string | null;
  status: string | null;
}

/**
 * The expanded body's blocker line — the ONE thing the collapsed row can't show.
 * The row's left glyph already states the status (running / needs-you / failed /
 * done) by color and the chip states the stage, so a plain "UAT failed" phrase is
 * pure duplication. The failure REASON (the stage verdict) is the new information,
 * so this is populated only when the current stage failed; `null` otherwise, and
 * the line is then not rendered at all.
 */
export interface Blocker {
  /** The failure reason (stage `verdict`), or null when the stage failed without one. */
  reason: string | null;
  /** Attempt the failure is filed under (0 when none). */
  attempt: number;
}

/**
 * Plain, vscode-free row model for the sidebar ticket list (§14). The webview
 * renders these; keeping the model pure makes it unit-testable without the editor
 * host and keeps the glyph as the single source (H1).
 */
export interface TicketNode {
  kind: 'ticket';
  ticketId: number;
  label: string;
  glyph: Glyph;
  /** Dimmed text beside the label — the current stage, visible when folded. */
  description: string;
  /**
   * Human stage phrase for the row pill and the expanded Stage line ("UAT
   * failed", "Not scoped"). Always set — `stageBadge` defines the fallback, so
   * a stageless ticket renders a phrase rather than an empty pill.
   */
  stageLabel: string;
  /**
   * Color class for the stage chip — the same `stg-<stage>` token the dashboard
   * rail paints with, so a stage reads the identical color in both views. Falls
   * back to `stg-unknown` for a stageless ticket rather than rendering uncolored.
   */
  stageClass: string;
  /**
   * The chip's TEXT: the bare stage key (the view uppercases it), NOT the
   * status phrase in `stageLabel`. Status is already the dot on the left of the
   * row, so the chip states only where the ticket is. `none` when there is no
   * stage yet.
   */
  stageChip: string;
  /**
   * The blocker line for the expanded body — the failure reason + attempt, and
   * only when the current stage failed. `null` (line omitted) otherwise, because
   * every non-failed status is already the row's left glyph color.
   */
  blocker: Blocker | null;
  /**
   * What the row's session button does and reads — "Continue" a captured
   * interactive session, or "Start" a fresh one. The single, always-visible
   * returning-user entry point, so it must never be a generic verb that hides
   * which of the two will happen.
   */
  sessionAction: SessionAction;
  /**
   * When the current stage last moved (its `endedAt` else `startedAt`), or null.
   * Raw ISO — the webview formats it relative to the viewer's clock ("4m ago").
   */
  lastActiveAt: string | null;
  /** Per-ticket launch model (`ticket.model`); null = inherit the manifest default. */
  model: string | null;
  /** True when soft-deleted; drives the archived row actions (unarchive/delete). */
  archived: boolean;
  /** The parent ticket's key, when this ticket was created via "create follow-up"; else null. */
  parentKey: string | null;
  /**
   * This ticket's sub-task parent id, when it is a sub-task; else null. The
   * id lets `nestSubtasks` order and indent the row under its parent without a
   * second lookup, and it is deliberately the SUB-TASK relation
   * (`subtaskParentId`), never the follow-up one.
   */
  subtaskParentId: number | null;
  /**
   * The parent's key, when this ticket is a sub-task; else null. Rendered as
   * `⊂ <parentKey>` — the sub-task relation marker (model/subtask.ts), which is
   * deliberately distinct from the follow-up `↳ <parentKey>` in `parentKey`.
   */
  subtaskParentKey: string | null;
  /**
   * Visual nesting depth assigned by `nestSubtasks` (0 = top level). 0 until
   * the list is nested, so a bare `buildTicketNodes` call needs no tree pass.
   */
  subtaskDepth: number;
  /**
   * How many DIRECT sub-tasks this row has, assigned by `nestSubtasks`. 0 for a
   * leaf. Drives the collapse control (a row with 0 renders no control). The
   * webview only hides/show its descendants — it never re-derives the tree.
   */
  subtaskChildCount: number;
  /**
   * Autostart phase at `scope` (`model/subtask.ts` `subtaskAutostartPhase`):
   * `queued` / `starting` / null. Host-derived (UI-R31); the webview renders
   * "Queued" / "Starting" in place of the stage chip.
   */
  autostart: SubtaskAutostartPhase | null;
  blockedBy?: string[];
  collapsible: true;
}

/** Map each ticket to a collapsible root node carrying its state glyph. */
export function buildTicketNodes(
  tickets: readonly TicketWithStages[],
  labelTemplate?: string,
  /** Manifest-level agent core; see `sessionAction`'s `provider`. */
  defaultProvider?: AgentProvider,
  /** id -> key, for every ticket in the project (not just the currently visible facet). */
  parentKeys: Map<number, string> = new Map(),
  /**
   * The effective defaults for a ticket's preset, so the session verb previews
   * the core a launch would use. Appended so every existing positional caller
   * keeps its argument positions. Absent → the legacy `defaultProvider`.
   */
  agentDefaults?: (ticketPreset: string | null, ticketProvider: AgentProvider | null) => AgentDefaults,
  blockersByTicket: Map<number, readonly TicketRelation[]> = new Map(),
): TicketNode[] {
  return tickets.map((t) => {
    const badge = stageBadge(t);
    const current = t.stages.find((s) => s.stageKey === t.stageCurrent);
    const failed = currentStageStatus(t) === 'failed';
    const blocker: Blocker | null = failed
      ? { reason: current?.verdict ?? null, attempt: current?.attempt ?? 0 }
      : null;
    const defaultCore = agentDefaults?.(t.agentPreset, t.agentProvider)?.provider ?? defaultProvider;
    return {
      kind: 'ticket',
      ticketId: t.id,
      label: ticketLabel(t, labelTemplate),
      glyph: badge.glyph,
      description: `${t.stageCurrent ?? 'none'} (${currentStageStatus(t)})`,
      stageLabel: badge.label,
      stageClass: stageColorClass(badge.stage),
      stageChip: badge.stage ?? 'none',
      blocker,
      // `defaultCore` is already the effective core when `agentDefaults` is
      // supplied; the resolve keeps an explicit ticket core when it is not.
      sessionAction: sessionAction(t, resolveProvider(t.agentProvider, defaultCore)),
      lastActiveAt: current?.endedAt ?? current?.startedAt ?? null,
      model: t.model,
      archived: t.archivedAt !== null,
      parentKey: t.parentTicketId !== null ? (parentKeys.get(t.parentTicketId) ?? null) : null,
      subtaskParentId: t.subtaskParentId,
      subtaskParentKey:
        t.subtaskParentId !== null ? (parentKeys.get(t.subtaskParentId) ?? null) : null,
      subtaskDepth: 0,
      subtaskChildCount: 0,
      autostart: subtaskAutostartPhase(t),
      blockedBy: (blockersByTicket.get(t.id) ?? []).map((r) => r.targetRef ?? (r.targetTicketId !== null ? (parentKeys.get(r.targetTicketId) ?? `#${r.targetTicketId}`) : 'unknown')),
      collapsible: true,
    };
  });
}

/**
 * Re-order a flat list into a parent-then-children tree for the sidebar, and
 * stamp each row's `subtaskDepth`. Sub-tasks directly follow their parent
 * (recursively), siblings keep their source order, and a row whose sub-task
 * parent is not in THIS list (a done parent in another section, a facet that
 * filtered it out) stays a root so it is never hidden by its own nesting.
 *
 * Pure and defensive: a malformed cycle or an over-deep chain is emitted once
 * as a root rather than recursing forever — the writer's depth cap and
 * create-only-parent rule make both impossible, but a renderer must not hang
 * on bad data.
 */
export function nestSubtasks<T extends TicketNode>(rows: readonly T[]): T[] {
  const present = new Set(rows.map((r) => r.ticketId));
  const childrenOf = new Map<number, T[]>();
  const isChild = new Set<number>();
  for (const r of rows) {
    const parentId = r.subtaskParentId;
    if (parentId === null || !present.has(parentId) || parentId === r.ticketId) continue;
    const bucket = childrenOf.get(parentId);
    if (bucket) bucket.push(r);
    else childrenOf.set(parentId, [r]);
    isChild.add(r.ticketId);
  }
  const out: T[] = [];
  const emitted = new Set<number>();
  const emit = (row: T, depth: number): void => {
    if (emitted.has(row.ticketId)) return;
    emitted.add(row.ticketId);
    const children = childrenOf.get(row.ticketId);
    out.push({ ...row, subtaskDepth: depth, subtaskChildCount: children ? children.length : 0 });
    if (!children) return;
    for (const child of children) emit(child, Math.min(depth + 1, MAX_SUBTASK_INDENT));
  };
  for (const row of rows) {
    if (isChild.has(row.ticketId)) continue;
    emit(row, 0);
  }
  // A pure cycle leaves no root; emit whatever remains so no row is dropped.
  for (const row of rows) emit(row, 0);
  return out;
}

/**
 * The deepest indent the sidebar paints. Derived from the writer's own
 * `MAX_SUBTASK_DEPTH` (`workflow/stages/subtask.ts`) so the two can never drift:
 * depth counts `-s<n>` segments, so a root is depth 0 and the writer permits
 * sub-tasks down to depth `MAX_SUBTASK_DEPTH` (e.g. `PROJ-1-s1-s1-s1-s1`). Every
 * legal depth gets its own indent; only a deeper chain (impossible through the
 * writer) is clamped. Clamping below a legal depth would merge a row into its
 * parent's slot, which also breaks `visibleTicketRows` (collapsing the parent
 * would not hide it).
 */
export const MAX_SUBTASK_INDENT = MAX_SUBTASK_DEPTH;

/**
 * The rows the sidebar should RENDER given which parent rows the user has
 * collapsed. A row is hidden when ANY strict ancestor is collapsed, so
 * collapsing a row hides its whole subtree, recursively. The collapsed row
 * itself stays visible — it is the control that re-expands it.
 *
 * Pure and host-side so the "collapsible, recursive" contract is unit-tested,
 * not just living in the webview's inline script. Input is `nestSubtasks`
 * output, so `subtaskDepth` is already stamped; this walks the ordering once,
 * tracking the ancestor in effect at each depth. That relies on every legal
 * depth having its own slot (`MAX_SUBTASK_INDENT === MAX_SUBTASK_DEPTH`).
 */
export function visibleTicketRows<T extends TicketNode>(
  rows: readonly T[],
  collapsed: ReadonlySet<number>,
): T[] {
  if (collapsed.size === 0) return [...rows];
  const out: T[] = [];
  const ancestors: number[] = [];
  for (const row of rows) {
    ancestors.length = row.subtaskDepth;
    ancestors[row.subtaskDepth] = row.ticketId;
    let hidden = false;
    for (let d = 0; d < row.subtaskDepth; d += 1) {
      const id = ancestors[d];
      if (id !== undefined && collapsed.has(id)) {
        hidden = true;
        break;
      }
    }
    if (!hidden) out.push(row);
  }
  return out;
}

/** Case-insensitive substring filter over key + title; blank query = all. */
export function filterTickets(
  tickets: readonly TicketWithStages[],
  query: string,
): TicketWithStages[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...tickets];
  return tickets.filter((t) =>
    `${t.key ?? ''} ${t.title ?? ''}`.toLowerCase().includes(q),
  );
}

/**
 * A ticket is COMPLETED when its current stage is the terminal `done` stage.
 * The sectioning source of truth — the Current list is everything this says no
 * to, so "completing a ticket removes it from Current" holds by construction,
 * and reopening a done ticket (stage moved away) restores it to Current
 * automatically. Deliberately `stageCurrent`, not the glyph-derived `done`
 * facet: the facet answers "is the row's dot green", while this answers "has
 * the ticket reached the terminal stage" — a ticket parked at a passed ship
 * is awaiting a merge (amber), never completed.
 */
export function isDoneTicket(t: TicketWithStages): boolean {
  return t.stageCurrent === 'done';
}

/**
 * A ticket is AWAITING REVIEW when it has reached the `ship` stage and has at
 * least one OPEN PR — the only remaining step is a team review on GitHub.
 *
 * The PR must be a real, literally `open` PR: `merged` and `closed` are terminal
 * (no review is coming), `draft` is not yet up for review, and `unknown`/null is
 * the absence of an answer, never a claim that review has started. A row with no
 * number is not an opened PR either. A ship ticket with no such PR (still
 * shipping, parked, or already landed) stays in the main Current list, and so
 * does one whose open PR has a merge conflict (`conflicted`): that is an
 * actionable item (Resolve conflicts), not a wait on reviewers.
 */
export function isAwaitingReview(
  t: Pick<TicketWithStages, 'stageCurrent'>,
  prs: readonly SidebarPr[],
  conflicted: boolean,
): boolean {
  return (
    t.stageCurrent === 'ship' &&
    !conflicted &&
    prs.some((p) => p.number !== null && p.status === 'open')
  );
}

/**
 * Completion timestamp for ordering the completed sections: the done stage's
 * end, else its start, else the ticket's own last update. `null` only when the
 * ticket carries no timestamp at all — such a ticket sorts LAST in every
 * newest-first list, never first (an unknown completion time must not read as
 * the most recent completion).
 *
 * The `updated_at` fallback is normalized to ISO-8601 UTC: some writers use
 * SQLite's `datetime('now')` space form, and a lexicographic comparison between
 * a space-form and a `T`-form timestamp of the same day mis-orders every pair
 * where the space-form time is actually later (model/time.ts's "one format"
 * invariant only holds for the stage writers).
 */
export function completedAt(t: TicketWithStages): string | null {
  const done = t.stages.find((s) => s.stageKey === 'done');
  const raw = done?.endedAt ?? done?.startedAt ?? t.updatedAt ?? null;
  if (raw === null) return null;
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  return /[zZ]$/.test(iso) ? iso : `${iso}Z`;
}
