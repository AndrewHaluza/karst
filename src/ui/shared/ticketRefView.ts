import type { Glyph } from '../../model/glyph.js';
import { formatId } from '../../model/entityId.js';
import { ticketGlyph } from '../../model/ticketGlyph.js';
import { STAGE_TITLE } from '../../model/stageBadge.js';
import { stageColorClass } from '../../model/stagePalette.js';
import { ALL_STAGE_KEYS, isFinishedStage, type StageKey } from '../../model/types.js';
import type { TicketWithStages } from '../../store/tickets.js';

export type TicketRefKind = 'ticket' | 'finished' | 'draft' | 'ref';

export interface TicketRefDisplayTextParts {
  /** Leading identifier: 'T963', 'D445→T970', 'D445', or 'ABC-123'. */
  readonly id: string;
  /** Key when applicable, e.g. 'FIX-101', or null. */
  readonly key: string | null;
  /** Stage word when applicable, e.g. 'impl', 'done', 'closed', or null. */
  readonly stage: string | null;
  /** Cross-session label (`P43`) for a planning dependency, or null. */
  readonly session: string | null;
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
  /** What the chip draws (state, stage class, word pair). Host-built so a vanilla view needs no stage table. */
  readonly chip?: RefChipParts;
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
  /** Cross-session label (`P43`) for a planning dependency, or null. */
  readonly sessionLabel?: string | null;
}


/** The stage's full title ("Implementation"), or the raw text for a stage this build does not know. */
export function stageWord(stage: string | null): { full: string; short: string } {
  if (!stage) return { full: '', short: '' };
  const key: StageKey | undefined = ALL_STAGE_KEYS.find((k) => k === stage);
  return key ? { full: STAGE_TITLE[key], short: key } : { full: stage, short: stage };
}

/**
 * The accessible name of a chip's link: id, stage title, and "needs you" when
 * the ticket waits on the user. The visible stage word is aria-hidden, so the
 * name must carry everything the word and the color say (@ui:11.21).
 */
function chipName(idLabel: string, stage: string | null, glyph: Glyph): string {
  const title = stageWord(stage).full;
  return [idLabel, title, glyph === 'amber' ? 'needs you' : ''].filter(Boolean).join(', ');
}

export type RefChipState = 'stage' | 'needs' | 'draft' | 'gone';

/** What the chip draws, shared by the React chip and the HTML string renderer. */
export interface RefChipParts {
  readonly state: RefChipState;
  /** `stg-<key>` class; empty for a draft or a missing reference (they have their own look). */
  readonly stageClass: string;
  /** Stage word for wide hosts (`data-full`). */
  readonly full: string;
  /** Stage word for hosts of 400px and less (`data-short`). */
  readonly short: string;
}

export function refChipParts(view: TicketRefView): RefChipParts {
  if (view.chip) return view.chip;
  if (view.kind === 'draft') return { state: 'draft', stageClass: '', full: 'Draft', short: 'Draft' };
  if (view.kind === 'ref') return { state: 'gone', stageClass: '', full: 'Missing', short: 'Missing' };
  const word = stageWord(view.stage);
  return {
    state: view.glyph === 'amber' ? 'needs' : 'stage',
    stageClass: stageColorClass(view.stage),
    ...word,
  };
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
  const view = buildRefView(input);
  return { ...view, chip: refChipParts(view) };
}

function buildRefView(input: TicketWithStages | TicketRefInput): TicketRefView {
  const opts: TicketRefInput = isTicketWithStages(input) ? { ticket: input } : input;
  const draftId = opts.draftId ?? null;
  const draftLabel = opts.draftLabel ?? (draftId !== null ? formatId('draft', draftId) : null);

  if (opts.ticket) {
    const t = opts.ticket;
    const ticketId = t.id;
    const ticketLabel = formatId('ticket', ticketId);
    const idLabel = draftLabel !== null ? `${draftLabel}→${ticketLabel}` : ticketLabel;
    const finishedStage = isFinishedStage(t.stageCurrent);
    const finished = finishedStage || t.archivedAt != null;
    const kind: TicketRefKind = finished ? 'finished' : 'ticket';
    // The word and the dot must describe the same state: never relabel an
    // archived in-progress ticket "done" while `ticketGlyph` keeps painting
    // its live stage colour. Only the real stage is shown.
    const stage = opts.stage ?? (t.stageCurrent ?? null);
    const glyph: Glyph = opts.glyph ?? ticketGlyph(t);
    const key = draftLabel !== null ? null : (t.key ?? null);
    const displayTextParts: TicketRefDisplayTextParts = {
      id: idLabel,
      key,
      stage,
      session: opts.sessionLabel ?? null,
    };
    const accessibleName = opts.accessibleName || chipName(idLabel, stage, glyph);
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
      session: opts.sessionLabel ?? null,
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
      accessibleName: opts.accessibleName ?? chipName(idLabel, stage, glyph),
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
      session: opts.sessionLabel ?? null,
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
    session: null,
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
    accessibleName: opts.accessibleName ?? `${rawRef}, missing`,
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

/** The class list of the chip root: base, stage token, and the state modifier. */
export function chipClass(parts: RefChipParts, extra = ''): string {
  const mod = parts.state === 'stage' ? '' : ` is-${parts.state}`;
  return `k-ticket-ref${parts.stageClass ? ` ${parts.stageClass}` : ''}${mod}${extra ? ` ${extra}` : ''}`;
}

/** The needs-you mark (@ui:UI-R28b): two bars, filled with the attention text tone. */
export const PAUSE_SVG =
  '<svg class="k-ticket-ref-pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/></svg>';

/** Formats the display text of a TicketRefView. */
export function formatTicketRefText(view: TicketRefView, options: { prefix?: string; showKey?: boolean } = {}): string {
  const prefix = options.prefix ?? '';
  const showKey = options.showKey ?? true;
  const parts = [
    view.displayTextParts.id,
    showKey && view.displayTextParts.key ? view.displayTextParts.key : null,
    view.displayTextParts.stage,
    view.displayTextParts.session,
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
  const parts = refChipParts(view);

  const idText = view.displayTextParts.id;
  const keyHtml = showKey && view.displayTextParts.key ? `<span class="k-ticket-ref-x"> · ${escapeHtml(view.displayTextParts.key)}</span>` : '';
  const sessionHtml = view.displayTextParts.session ? `<span class="k-ticket-ref-x"> · ${escapeHtml(view.displayTextParts.session)}</span>` : '';
  const name = escapeHtml(view.accessibleName);

  const isLink = link && view.ticketId !== null;
  const idHtml = isLink
    ? `<a href="#" data-act="${escapeHtml(dataAct)}" ${dataIdAttr}="${escapeHtml(String(view.ticketId))}" aria-label="${name}">${escapeHtml(idText)}</a>`
    : `<span class="k-ticket-ref-id">${escapeHtml(idText)}</span>`;
  const word = parts.full
    ? `<span class="k-ticket-ref-word" data-full="${escapeHtml(parts.full)}" data-short="${escapeHtml(parts.short)}" aria-hidden="true"></span>`
    : '';
  const pause = parts.state === 'needs' ? PAUSE_SVG : '';
  const titleAttr = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
  const prefixHtml = prefix ? `<span class="k-ticket-ref-prefix">${escapeHtml(prefix)}</span>` : '';
  const cls = chipClass(parts);
  const nameAttr = isLink ? '' : ` aria-label="${name}"`;
  return `<span class="${cls}"${nameAttr}${titleAttr}>${prefixHtml}${pause}${idHtml}${keyHtml}${word}${sessionHtml}</span>`;
}
