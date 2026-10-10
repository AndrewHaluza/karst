/**
 * Pure layout checks over a serialized DOM snapshot (layout-sanity gate).
 *
 * jsdom has no layout engine (docs/ui/UI-INVARIANTS.md), so geometry is measured
 * in Playwright (`layout.layout.ts` collects the snapshot) and judged here, where
 * every check has a positive and a negative unit fixture. No baselines: a check
 * either holds or it does not, so re-recording cannot turn it green.
 *
 * Tolerance is 1px throughout. See docs/ui/VISUAL-COVERAGE.md `ui:LAYOUT-SANITY`.
 */

import type { LayoutTier } from './layoutBreakpoints.js';

export const TOLERANCE = 1;
/** Icon-only interactive minimum (DESIGN-SYSTEM sizing block, `--k-hit-min`). */
export const MIN_ICON_PX = 24;
/** Minimum height of a control that carries a text label. */
export const MIN_TEXT_CONTROL_H = 20;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ElementSnap {
  readonly id: number;
  /** Nearest rendered ancestor (display:contents / hidden ancestors skipped). */
  readonly parentId: number | null;
  /** Stable selector path from <body>. */
  readonly path: string;
  readonly tag: string;
  /** Explicit role attribute, else the implicit role of table parts / controls. */
  readonly role: string | null;
  /** <input type>, lower-cased; null for every other element. */
  readonly inputType: string | null;
  readonly rect: Rect;
  readonly position: string;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly textOverflow: string;
  readonly scrollW: number;
  readonly clientW: number;
  readonly scrollH: number;
  readonly clientH: number;
  readonly colSpan: number;
  /** aria-label / aria-describedby / aria-expanded present: full text reachable. */
  readonly exposesText: boolean;
  /** Visible text content (trimmed, non-empty). */
  readonly hasText: boolean;
  /** `data-region` attribute value; marks a pane root. */
  readonly region: string | null;
  /** Carries the primary-action class (`k-btn--primary`). */
  readonly primaryAction: boolean;
}

export interface LayoutSnapshot {
  readonly viewport: { readonly w: number; readonly h: number };
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly elements: readonly ElementSnap[];
}

export type LayoutCheck =
  | 'page-overflow'
  | 'sibling-overlap'
  | 'containment'
  | 'clipped-text'
  | 'column-alignment'
  | 'degenerate-control'
  | 'scroller'
  | 'region-order'
  | 'section-spacing'
  | 'state-survives-resize';

export interface LayoutFailure {
  readonly route: string;
  readonly width: number;
  readonly check: LayoutCheck;
  readonly selector: string;
  readonly rects: readonly Rect[];
  readonly detail: string;
}

type Found = Omit<LayoutFailure, 'route' | 'width'>;

const IN_FLOW = new Set(['static', 'relative', 'sticky']);
const CLIPPING = new Set(['hidden', 'clip']);
const CONTROL_TAGS = new Set(['button', 'input', 'select', 'textarea']);
const CONTROL_ROLES = new Set(['tab', 'button']);
const TABLE_ROLES = new Set(['table', 'grid']);
/** Native 13px boxes: the label is the target, so their size is not a collapse. */
const NATIVE_TOGGLES = new Set(['checkbox', 'radio']);
/** The sr-only pattern clips a 1x1 box on purpose; it is not visible text. */
const VISUALLY_HIDDEN_PX = 1;
const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);

const px = (n: number): string => String(Math.round(n * 10) / 10);

function pageOverflow(s: LayoutSnapshot): Found[] {
  if (s.scrollWidth <= s.clientWidth + TOLERANCE) return [];
  return [{
    check: 'page-overflow',
    selector: 'document',
    rects: [],
    detail: `scrollWidth ${s.scrollWidth} > clientWidth ${s.clientWidth}`,
  }];
}

function intersection(a: Rect, b: Rect): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  };
}

function siblingOverlap(s: LayoutSnapshot): Found[] {
  const groups = new Map<number | null, ElementSnap[]>();
  for (const e of s.elements) {
    if (!IN_FLOW.has(e.position)) continue;
    groups.set(e.parentId, [...(groups.get(e.parentId) ?? []), e]);
  }
  const out: Found[] = [];
  for (const siblings of groups.values()) {
    for (let i = 0; i < siblings.length; i += 1) {
      for (let j = i + 1; j < siblings.length; j += 1) {
        const a = siblings[i]!;
        const b = siblings[j]!;
        const hit = intersection(a.rect, b.rect);
        if (hit.w <= TOLERANCE || hit.h <= TOLERANCE) continue;
        out.push({
          check: 'sibling-overlap',
          selector: `${a.path} | ${b.path}`,
          rects: [a.rect, b.rect],
          detail: `siblings overlap by ${px(hit.w)}x${px(hit.h)}px`,
        });
      }
    }
  }
  return out;
}

function containment(s: LayoutSnapshot): Found[] {
  const byId = new Map(s.elements.map((e) => [e.id, e]));
  const out: Found[] = [];
  for (const e of s.elements) {
    const parent = e.parentId === null ? undefined : byId.get(e.parentId);
    if (!parent || !IN_FLOW.has(e.position)) continue;
    if (parent.overflowX !== 'visible' || parent.overflowY !== 'visible') continue;
    const over = {
      left: parent.rect.x - e.rect.x,
      top: parent.rect.y - e.rect.y,
      right: e.rect.x + e.rect.w - (parent.rect.x + parent.rect.w),
      bottom: e.rect.y + e.rect.h - (parent.rect.y + parent.rect.h),
    };
    const worst = Math.max(over.left, over.top, over.right, over.bottom);
    if (worst <= TOLERANCE) continue;
    out.push({
      check: 'containment',
      selector: e.path,
      rects: [e.rect, parent.rect],
      detail: `extends ${px(worst)}px outside its parent ${parent.path}`,
    });
  }
  return out;
}

function clippedText(s: LayoutSnapshot): Found[] {
  const out: Found[] = [];
  for (const e of s.elements) {
    const clipX = CLIPPING.has(e.overflowX) && e.scrollW > e.clientW + TOLERANCE;
    const clipY = CLIPPING.has(e.overflowY) && e.scrollH > e.clientH + TOLERANCE;
    if (!clipX && !clipY) continue;
    if (e.rect.w <= VISUALLY_HIDDEN_PX && e.rect.h <= VISUALLY_HIDDEN_PX) continue;
    if (e.textOverflow === 'ellipsis' && e.exposesText) continue;
    const why = e.textOverflow !== 'ellipsis' ? 'no ellipsis' : 'ellipsis without aria-label/aria-describedby/expansion';
    out.push({
      check: 'clipped-text',
      selector: e.path,
      rects: [e.rect],
      detail: `content ${clipX ? `${e.scrollW}>${e.clientW}px wide` : `${e.scrollH}>${e.clientH}px tall`} is clipped (${why})`,
    });
  }
  return out;
}

function descendants(s: LayoutSnapshot, rootId: number, role: (e: ElementSnap) => boolean): ElementSnap[] {
  const members = new Set<number>([rootId]);
  const found: ElementSnap[] = [];
  for (const e of s.elements) {
    if (e.parentId !== null && members.has(e.parentId)) {
      members.add(e.id);
      if (role(e)) found.push(e);
    }
  }
  return found;
}

function cellsOf(s: LayoutSnapshot, row: ElementSnap): ElementSnap[] {
  return s.elements.filter((e) => e.parentId === row.id && e.role !== null && CELL_ROLES.has(e.role));
}

function columnAlignment(s: LayoutSnapshot): Found[] {
  const out: Found[] = [];
  for (const table of s.elements.filter((e) => e.role !== null && TABLE_ROLES.has(e.role))) {
    const rows = descendants(s, table.id, (e) => e.role === 'row');
    const header = rows.find((r) => cellsOf(s, r).some((c) => c.role === 'columnheader'));
    if (!header) continue;
    const head = cellsOf(s, header);
    for (const row of rows.filter((r) => r.id !== header.id)) {
      const cells = cellsOf(s, row);
      if (cells.some((c) => c.colSpan > 1) || head.some((c) => c.colSpan > 1)) continue;
      cells.forEach((cell, i) => {
        const ref = head[i];
        if (!ref || Math.abs(cell.rect.x - ref.rect.x) <= TOLERANCE) return;
        out.push({
          check: 'column-alignment',
          selector: cell.path,
          rects: [cell.rect, ref.rect],
          detail: `column ${i + 1} left edge ${px(cell.rect.x)} != header ${px(ref.rect.x)}`,
        });
      });
    }
  }
  return out;
}

function isControl(e: ElementSnap): boolean {
  if (e.inputType !== null && NATIVE_TOGGLES.has(e.inputType)) return false;
  return CONTROL_TAGS.has(e.tag) || (e.tag === 'a' && e.role === 'link') || (e.role !== null && CONTROL_ROLES.has(e.role));
}

function degenerateControl(s: LayoutSnapshot): Found[] {
  const out: Found[] = [];
  for (const e of s.elements.filter(isControl)) {
    const tiny = e.hasText
      ? e.rect.h < MIN_TEXT_CONTROL_H
      : e.rect.w < MIN_ICON_PX || e.rect.h < MIN_ICON_PX;
    const off = e.rect.x < -TOLERANCE || e.rect.x + e.rect.w > s.viewport.w + TOLERANCE;
    if (!tiny && !off) continue;
    const min = e.hasText ? `height min ${MIN_TEXT_CONTROL_H}` : `min ${MIN_ICON_PX}x${MIN_ICON_PX}`;
    out.push({
      check: 'degenerate-control',
      selector: e.path,
      rects: [e.rect],
      detail: tiny ? `control is ${px(e.rect.w)}x${px(e.rect.h)}px (${min})` : 'control lies outside the viewport horizontally',
    });
  }
  return out;
}

function isScroller(e: ElementSnap): boolean {
  const x = (e.overflowX === 'auto' || e.overflowX === 'scroll') && e.scrollW > e.clientW + TOLERANCE;
  const y = (e.overflowY === 'auto' || e.overflowY === 'scroll') && e.scrollH > e.clientH + TOLERANCE;
  return x || y;
}

/** Nearest ancestor that is a `data-region` root; null = the page. */
function paneOf(byId: ReadonlyMap<number, ElementSnap>, e: ElementSnap): ElementSnap | null {
  for (let id = e.parentId; id !== null; ) {
    const p = byId.get(id);
    if (!p) return null;
    if (p.region !== null) return p;
    id = p.parentId;
  }
  return null;
}

function scrollers(s: LayoutSnapshot): Found[] {
  const byId = new Map(s.elements.map((e) => [e.id, e]));
  const out: Found[] = [];
  const perPane = new Map<number | null, ElementSnap[]>();
  for (const e of s.elements.filter(isScroller)) {
    const pane = paneOf(byId, e);
    perPane.set(pane?.id ?? null, [...(perPane.get(pane?.id ?? null) ?? []), e]);
    const outsideViewport = e.rect.x < -TOLERANCE || e.rect.x + e.rect.w > s.viewport.w + TOLERANCE || e.rect.h > s.viewport.h + TOLERANCE;
    const outsidePane = pane !== null && (
      e.rect.x < pane.rect.x - TOLERANCE ||
      e.rect.x + e.rect.w > pane.rect.x + pane.rect.w + TOLERANCE ||
      e.rect.y < pane.rect.y - TOLERANCE ||
      e.rect.y + e.rect.h > pane.rect.y + pane.rect.h + TOLERANCE
    );
    if (!outsideViewport && !outsidePane) continue;
    out.push({
      check: 'scroller',
      selector: e.path,
      rects: pane ? [e.rect, pane.rect] : [e.rect],
      detail: outsideViewport ? 'scroll container extends outside the viewport' : `scroll container extends outside its pane ${pane?.path ?? ''}`,
    });
  }
  for (const group of perPane.values()) {
    for (const extra of group.slice(1)) {
      out.push({
        check: 'scroller',
        selector: extra.path,
        rects: [extra.rect],
        detail: `second scroll container in one pane (first: ${group[0]!.path})`,
      });
    }
  }
  return out;
}

/** In-flow children of `parent`, top to bottom. */
function flowChildren(s: LayoutSnapshot, parentId: number): ElementSnap[] {
  return s.elements
    .filter((e) => e.parentId === parentId && IN_FLOW.has(e.position))
    .sort((a, b) => a.rect.y - b.rect.y);
}

function maxVerticalGap(items: readonly ElementSnap[]): number {
  let max = 0;
  for (let i = 1; i < items.length; i += 1) {
    max = Math.max(max, items[i]!.rect.y - (items[i - 1]!.rect.y + items[i - 1]!.rect.h));
  }
  return max;
}

/** UX-7: sections must be separated by more than the items inside them. */
function sectionSpacing(s: LayoutSnapshot): Found[] {
  const out: Found[] = [];
  const parents = new Set(s.elements.filter((e) => e.tag === 'section').map((e) => e.parentId));
  for (const parentId of parents) {
    if (parentId === null) continue;
    const sections = flowChildren(s, parentId).filter((e) => e.tag === 'section');
    for (let i = 1; i < sections.length; i += 1) {
      const prev = sections[i - 1]!;
      const next = sections[i]!;
      const between = next.rect.y - (prev.rect.y + prev.rect.h);
      const inner = Math.max(maxVerticalGap(flowChildren(s, prev.id)), maxVerticalGap(flowChildren(s, next.id)));
      if (between > inner) continue;
      out.push({
        check: 'section-spacing',
        selector: `${prev.path} | ${next.path}`,
        rects: [prev.rect, next.rect],
        detail: `gap between sections ${px(between)}px is not larger than the largest gap inside one (${px(inner)}px)`,
      });
    }
  }
  return out;
}

/** UX-1: expected region placement for one route at one tier. */
export interface RegionExpectation {
  /** `data-region` names, in expected top-to-bottom (stacked) or left-to-right order. */
  readonly order: readonly string[];
  readonly layout: 'side-by-side' | 'stacked';
}

/** tests/visual/expectations/<section>.json: expectations per tier. */
export type RegionExpectations = Readonly<Partial<Record<LayoutTier, RegionExpectation>>>;

/** R40: the primary action sits inside the header or toolbar region. */
const PRIMARY_HOMES = new Set(['header', 'toolbar']);

function regionOrder(s: LayoutSnapshot, expected: RegionExpectation | undefined): Found[] {
  if (!expected) return [];
  const out: Found[] = [];
  const byName = new Map(s.elements.filter((e) => e.region !== null).map((e) => [e.region!, e]));
  const present: ElementSnap[] = [];
  for (const name of expected.order) {
    const hit = byName.get(name);
    if (hit) present.push(hit);
    else out.push({ check: 'region-order', selector: `[data-region="${name}"]`, rects: [], detail: `expected region "${name}" is not rendered` });
  }
  for (let i = 1; i < present.length; i += 1) {
    const a = present[i - 1]!;
    const b = present[i]!;
    const ok = expected.layout === 'stacked'
      ? b.rect.y >= a.rect.y + a.rect.h - TOLERANCE
      : b.rect.x >= a.rect.x + a.rect.w - TOLERANCE && Math.abs(a.rect.y - b.rect.y) <= a.rect.h;
    if (ok) continue;
    out.push({
      check: 'region-order',
      selector: `${a.path} | ${b.path}`,
      rects: [a.rect, b.rect],
      detail: `regions "${a.region}" then "${b.region}" are not ${expected.layout} in that order`,
    });
  }
  const byId = new Map(s.elements.map((e) => [e.id, e]));
  for (const primary of s.elements.filter((e) => e.primaryAction)) {
    const home = paneOf(byId, primary);
    if (home !== null && PRIMARY_HOMES.has(home.region ?? '')) continue;
    out.push({
      check: 'region-order',
      selector: primary.path,
      rects: [primary.rect],
      detail: `primary action is in region "${home?.region ?? 'page'}", not the header or toolbar`,
    });
  }
  return out;
}

/** UX-8a: the hash and the selected item are unchanged after a resize round trip. */
export interface ResizeState {
  readonly hash: string;
  readonly selected: string | null;
}

export function stateSurvivesResize(before: ResizeState, after: ResizeState): LayoutFailure[] {
  const changed = [
    before.hash !== after.hash ? `hash ${before.hash} -> ${after.hash}` : '',
    before.selected !== after.selected ? `selected ${String(before.selected)} -> ${String(after.selected)}` : '',
  ].filter(Boolean);
  if (changed.length === 0) return [];
  return [{ route: '', width: 0, check: 'state-survives-resize', selector: 'document', rects: [], detail: changed.join('; ') }];
}

/** Every check over one snapshot; route/width are stamped on by the caller. */
export function runChecks(s: LayoutSnapshot, expected?: RegionExpectation): LayoutFailure[] {
  const found = [
    ...pageOverflow(s),
    ...siblingOverlap(s),
    ...containment(s),
    ...clippedText(s),
    ...columnAlignment(s),
    ...degenerateControl(s),
    ...scrollers(s),
    ...regionOrder(s, expected),
    ...sectionSpacing(s),
  ];
  return found.map((f) => ({ route: '', width: s.viewport.w, ...f }));
}

/** Ledger key: route + width + check + selector. */
export function failureKey(f: Pick<LayoutFailure, 'route' | 'width' | 'check' | 'selector'>): string {
  return `${f.route}|${f.width}|${f.check}|${f.selector}`;
}
