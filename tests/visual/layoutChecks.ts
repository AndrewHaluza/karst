/**
 * Pure layout checks over a serialized DOM snapshot (layout-sanity gate).
 *
 * jsdom has no layout engine (docs/ui/UI-INVARIANTS.md), so geometry is measured
 * in Playwright (`layout.visual.ts` collects the snapshot) and judged here, where
 * every check has a positive and a negative unit fixture. No baselines: a check
 * either holds or it does not, so re-recording cannot turn it green.
 *
 * Tolerance is 1px throughout. See docs/ui/VISUAL-COVERAGE.md `ui:LAYOUT-SANITY`.
 */

export const TOLERANCE = 1;
export const MIN_CONTROL_PX = 16;

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
  | 'degenerate-control';

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
    const tiny = e.rect.w < MIN_CONTROL_PX || e.rect.h < MIN_CONTROL_PX;
    const off = e.rect.x < -TOLERANCE || e.rect.x + e.rect.w > s.viewport.w + TOLERANCE;
    if (!tiny && !off) continue;
    out.push({
      check: 'degenerate-control',
      selector: e.path,
      rects: [e.rect],
      detail: tiny ? `control is ${px(e.rect.w)}x${px(e.rect.h)}px (min ${MIN_CONTROL_PX})` : 'control lies outside the viewport horizontally',
    });
  }
  return out;
}

/** Every check over one snapshot; route/width are stamped on by the caller. */
export function runChecks(s: LayoutSnapshot): LayoutFailure[] {
  const found = [
    ...pageOverflow(s),
    ...siblingOverlap(s),
    ...containment(s),
    ...clippedText(s),
    ...columnAlignment(s),
    ...degenerateControl(s),
  ];
  return found.map((f) => ({ route: '', width: s.viewport.w, ...f }));
}

/** Ledger key: route + width + check + selector. */
export function failureKey(f: Pick<LayoutFailure, 'route' | 'width' | 'check' | 'selector'>): string {
  return `${f.route}|${f.width}|${f.check}|${f.selector}`;
}

export interface LedgerResult {
  /** Failures the ledger does not list. */
  readonly unexpected: readonly LayoutFailure[];
  /** Ledger keys that no longer reproduce; delete them. */
  readonly stale: readonly string[];
}

/** The ledger only shrinks: unknown failures AND stale entries both fail. */
export function applyLedger(failures: readonly LayoutFailure[], ledger: readonly string[]): LedgerResult {
  const known = new Set(ledger);
  const seen = new Set(failures.map(failureKey));
  return {
    unexpected: failures.filter((f) => !known.has(failureKey(f))),
    stale: ledger.filter((key) => !seen.has(key)),
  };
}
