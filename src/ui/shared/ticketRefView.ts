import type { Glyph } from '../../model/glyph.js';
import { formatId } from '../../model/entityId.js';
import { ticketGlyph } from '../../model/ticketGlyph.js';
import { isFinishedStage } from '../../model/types.js';
import type { TicketWithStages } from '../../store/tickets.js';

export type TicketRefKind = 'ticket' | 'finished' | 'draft' | 'ref';

export interface TicketRefDisplayTextParts {
  /** Leading identifier: 'T963', 'D445→T970', 'D445', or 'ABC-123'. */
  readonly id: string;
  /** Key when applicable, e.g. 'FIX-101', or null. */
  readonly key: string | null;
  /** Stage word when applicable, e.g. 'impl', 'done', 'closed', or null. */
  readonly stage: string | null;
}

export interface TicketRefView {
  readonly id?: number | null;
  readonly kind: TicketRefKind;
  readonly ticketId: number | null;
  readonly idLabel: string | null;
  readonly keyOrRef: string | null;
  readonly stage: string | null;
  readonly glyph: Glyph;
  readonly displayTextParts: TicketRefDisplayTextParts;
  readonly accessibleName: string;
  /** Optional originating draft id (e.g. 445 for D445). */
  readonly draftId?: number | null;
  readonly label?: string;
  readonly done?: boolean;
}

export interface TicketRefInput {
  readonly ticket?: TicketWithStages | null;
  readonly ticketId?: number | null;
  readonly draftId?: number | null;
  readonly draftLabel?: string | null;
  readonly ref?: string | null;
  readonly stage?: string | null;
  readonly keyOrRef?: string | null;
  readonly idLabel?: string | null;
  readonly glyph?: Glyph | null;
  readonly accessibleName?: string | null;
  readonly label?: string | null;
}

function isTicketWithStages(val: unknown): val is TicketWithStages {
  return typeof val === 'object' && val !== null && 'id' in val && ('stages' in val || 'stageCurrent' in val);
}

/**
 * Pure host-side view builder for a reference to a ticket, draft, or dangling ref.
 * Glyph is derived once from `ticketGlyph`.
 */
export function ticketRefView(input: TicketWithStages | TicketRefInput | TicketRefView): TicketRefView {
  if (typeof input === 'object' && input !== null && 'displayTextParts' in input) {
    return input as TicketRefView;
  }
  const opts: TicketRefInput = isTicketWithStages(input) ? { ticket: input } : input;
  const draftId = opts.draftId ?? null;
  const draftLabel = opts.draftLabel ?? (draftId !== null ? formatId('draft', draftId) : null);

  if (opts.ticket) {
    const t = opts.ticket;
    const ticketId = t.id;
    const ticketLabel = formatId('ticket', ticketId);
    const idLabel = draftLabel !== null ? `${draftLabel}→${ticketLabel}` : ticketLabel;
    const finished = isFinishedStage(t.stageCurrent) || t.archivedAt != null;
    const kind: TicketRefKind = finished ? 'finished' : 'ticket';
    const stage = opts.stage ?? (finished ? (t.stageCurrent === 'closed' ? 'closed' : 'done') : (t.stageCurrent ?? null));
    const glyph: Glyph = opts.glyph ?? ticketGlyph(t);
    const key = draftLabel !== null ? null : (t.key ?? null);
    const displayTextParts: TicketRefDisplayTextParts = {
      id: idLabel,
      key,
      stage,
    };
    let accessibleName: string;
    if (opts.accessibleName) {
      accessibleName = opts.accessibleName;
    } else if (draftLabel !== null) {
      accessibleName = finished
        ? `${draftLabel}, ticket ${ticketLabel} ${stage}`
        : `${draftLabel}, ticket ${ticketLabel} in ${stage || 'progress'}`;
    } else {
      accessibleName = finished
        ? `Ticket ${ticketLabel} ${stage}`
        : `Ticket ${ticketLabel} in ${stage || 'progress'}`;
    }
    return {
      id: draftId ?? ticketId,
      kind,
      ticketId,
      idLabel,
      keyOrRef: t.key ?? null,
      stage,
      glyph,
      displayTextParts,
      accessibleName,
      draftId,
      label: t.key ?? ticketLabel,
      done: finished,
    };
  }

  if (opts.ticketId != null) {
    const ticketId = opts.ticketId;
    const ticketLabel = opts.idLabel ?? formatId('ticket', ticketId);
    const idLabel = draftLabel !== null ? `${draftLabel}→${ticketLabel}` : ticketLabel;
    const key = draftLabel !== null ? null : (opts.keyOrRef ?? opts.label ?? null);
    const stage = opts.stage ?? null;
    const kind: TicketRefKind = stage === 'done' || stage === 'closed' ? 'finished' : 'ticket';
    const glyph: Glyph = opts.glyph ?? (kind === 'finished' ? (stage === 'closed' ? 'gray' : 'green') : 'blue');
    const displayTextParts: TicketRefDisplayTextParts = {
      id: idLabel,
      key,
      stage,
    };
    return {
      id: draftId ?? ticketId,
      kind,
      ticketId,
      idLabel,
      keyOrRef: key,
      stage,
      glyph,
      displayTextParts,
      accessibleName: opts.accessibleName ?? `Ticket ${ticketLabel}${stage ? ` in ${stage}` : ''}`,
      draftId,
      label: key ?? ticketLabel,
      done: kind === 'finished',
    };
  }

  if (draftId !== null) {
    const idLabel = draftLabel!;
    const displayTextParts: TicketRefDisplayTextParts = {
      id: idLabel,
      key: null,
      stage: null,
    };
    return {
      id: draftId,
      kind: 'draft',
      ticketId: null,
      idLabel,
      keyOrRef: null,
      stage: null,
      glyph: 'gray',
      displayTextParts,
      accessibleName: opts.accessibleName ?? `${idLabel}, draft pending`,
      draftId,
      label: idLabel,
      done: false,
    };
  }

  const rawRef = opts.ref ?? opts.keyOrRef ?? opts.idLabel ?? opts.label ?? '';
  const displayTextParts: TicketRefDisplayTextParts = {
    id: rawRef,
    key: null,
    stage: null,
  };
  return {
    id: null,
    kind: 'ref',
    ticketId: null,
    idLabel: opts.idLabel ?? null,
    keyOrRef: rawRef,
    stage: null,
    glyph: opts.glyph ?? 'gray',
    displayTextParts,
    accessibleName: opts.accessibleName ?? rawRef,
    draftId: null,
    label: rawRef,
    done: false,
  };
}

export interface TicketRefRenderOptions {
  readonly prefix?: string;
  readonly link?: boolean;
  readonly showKey?: boolean;
  readonly dataAct?: string;
  readonly dataIdAttr?: 'data-id' | 'data-ticket';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Formats the display text of a TicketRefView. */
export function formatTicketRefText(view: TicketRefView, options: { prefix?: string; showKey?: boolean } = {}): string {
  const prefix = options.prefix ?? '';
  const showKey = options.showKey ?? true;
  const parts = [
    view.displayTextParts.id,
    showKey && view.displayTextParts.key ? view.displayTextParts.key : null,
    view.displayTextParts.stage,
  ].filter(Boolean);
  return `${prefix}● ${parts.join(' · ')}`;
}

/**
 * Pure HTML string renderer for non-React surfaces (ticket form, etc.).
 * Mirrors the DOM contract of `TicketRefChip` so text and accessibleName match.
 */
export function renderTicketRefHtml(view: TicketRefView, options: TicketRefRenderOptions = {}): string {
  const prefix = options.prefix ?? '';
  const link = options.link ?? true;
  const showKey = options.showKey ?? true;
  const dataAct = options.dataAct ?? 'open-dependency';
  const dataIdAttr = options.dataIdAttr ?? 'data-ticket';
  const tooltip = !showKey && view.keyOrRef ? view.keyOrRef : null;

  const idText = view.displayTextParts.id;
  const keyPart = showKey && view.displayTextParts.key ? ` · ${escapeHtml(view.displayTextParts.key)}` : '';
  const stagePart = view.displayTextParts.stage ? ` · ${escapeHtml(view.displayTextParts.stage)}` : '';

  let idHtml = escapeHtml(idText);
  if (link && view.ticketId !== null) {
    idHtml = `<a href="#" data-act="${escapeHtml(dataAct)}" ${dataIdAttr}="${escapeHtml(String(view.ticketId))}">${escapeHtml(idText)}</a>`;
  }

  const titleAttr = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
  const prefixHtml = prefix ? `<span>${escapeHtml(prefix)}</span>` : '';
  return `<span class="k-ticket-ref" aria-label="${escapeHtml(view.accessibleName)}"${titleAttr}>${prefixHtml}<span class="k-ticket-ref-dot g-${escapeHtml(view.glyph)}" aria-hidden="true"></span><span>${idHtml}${keyPart}${stagePart}</span></span>`;
}
