import { describe, expect, it } from 'vitest';
import {
  applyLedger,
  failureKey,
  runChecks,
  type ElementSnap,
  type LayoutFailure,
  type LayoutSnapshot,
} from './layoutChecks.js';

let nextId = 0;
function el(over: Omit<Partial<ElementSnap>, 'rect'> & { rect?: Partial<ElementSnap['rect']> } = {}): ElementSnap {
  const { rect, ...rest } = over;
  nextId += 1;
  return {
    id: nextId,
    parentId: null,
    path: `div:nth-child(${nextId})`,
    tag: 'div',
    role: null,
    inputType: null,
    rect: { x: 0, y: 0, w: 100, h: 20, ...rect },
    position: 'static',
    overflowX: 'visible',
    overflowY: 'visible',
    textOverflow: 'clip',
    scrollW: 100,
    clientW: 100,
    scrollH: 20,
    clientH: 20,
    colSpan: 1,
    exposesText: false,
    ...rest,
  };
}

function snap(elements: ElementSnap[], over: Partial<LayoutSnapshot> = {}): LayoutSnapshot {
  return { viewport: { w: 1280, h: 900 }, scrollWidth: 1280, clientWidth: 1280, elements, ...over };
}

const checksOf = (s: LayoutSnapshot, check: string): LayoutFailure[] =>
  runChecks(s).filter((f) => f.check === check);

describe('page-overflow', () => {
  it('fails when the page scrolls horizontally', () => {
    const f = checksOf(snap([], { scrollWidth: 1400 }), 'page-overflow');
    expect(f).toHaveLength(1);
    expect(f[0]?.detail).toContain('1400');
  });
  it('passes within 1px', () => {
    expect(checksOf(snap([], { scrollWidth: 1281 }), 'page-overflow')).toEqual([]);
  });
});

describe('sibling-overlap', () => {
  const parent = el({ rect: { w: 400, h: 100 } });
  const mk = (x: number, y: number, over: Omit<Partial<ElementSnap>, 'rect'> = {}) =>
    el({ parentId: parent.id, rect: { x, y, w: 100, h: 20 }, ...over });
  it('fails on in-flow siblings intersecting in both axes', () => {
    const f = checksOf(snap([parent, mk(0, 0), mk(50, 10)]), 'sibling-overlap');
    expect(f).toHaveLength(1);
    expect(f[0]?.rects).toHaveLength(2);
  });
  it('passes when siblings merely touch or overlap by 1px', () => {
    expect(checksOf(snap([parent, mk(0, 0), mk(99, 0)]), 'sibling-overlap')).toEqual([]);
  });
  it('ignores absolutely positioned siblings', () => {
    expect(checksOf(snap([parent, mk(0, 0), mk(50, 10, { position: 'absolute' })]), 'sibling-overlap')).toEqual([]);
  });
});

describe('containment', () => {
  const parent = el({ rect: { x: 0, y: 0, w: 200, h: 50 } });
  it('fails when a child pokes out of a visible-overflow parent', () => {
    const child = el({ parentId: parent.id, rect: { x: 150, y: 0, w: 100, h: 20 } });
    expect(checksOf(snap([parent, child]), 'containment')).toHaveLength(1);
  });
  it('exempts scroll containers', () => {
    const scroller = { ...parent, overflowX: 'auto' };
    const child = el({ parentId: parent.id, rect: { x: 150, y: 0, w: 100, h: 20 } });
    expect(checksOf(snap([scroller, child]), 'containment')).toEqual([]);
  });
  it('passes within 1px and for absolutely positioned children', () => {
    const near = el({ parentId: parent.id, rect: { x: 100, y: 0, w: 101, h: 20 } });
    const abs = el({ parentId: parent.id, position: 'absolute', rect: { x: 300, y: 0, w: 10, h: 10 } });
    expect(checksOf(snap([parent, near, abs]), 'containment')).toEqual([]);
  });
});

describe('clipped-text', () => {
  const clipped = (over: Parameters<typeof el>[0] = {}) =>
    el({ overflowX: 'hidden', scrollW: 300, clientW: 100, ...over });
  it('fails on hidden overflow with no ellipsis', () => {
    expect(checksOf(snap([clipped()]), 'clipped-text')).toHaveLength(1);
  });
  it('fails on an ellipsis whose full text is not exposed (title does not count)', () => {
    expect(checksOf(snap([clipped({ textOverflow: 'ellipsis' })]), 'clipped-text')).toHaveLength(1);
  });
  it('passes on an ellipsis with the full text exposed', () => {
    expect(checksOf(snap([clipped({ textOverflow: 'ellipsis', exposesText: true })]), 'clipped-text')).toEqual([]);
  });
  it('ignores the 1x1 sr-only pattern', () => {
    expect(checksOf(snap([clipped({ rect: { w: 1, h: 1 } })]), 'clipped-text')).toEqual([]);
  });
  it('fails on vertical clipping and passes when nothing is clipped', () => {
    expect(checksOf(snap([el({ overflowY: 'clip', scrollH: 80, clientH: 20 })]), 'clipped-text')).toHaveLength(1);
    expect(checksOf(snap([el({ overflowX: 'hidden', scrollW: 101 })]), 'clipped-text')).toEqual([]);
  });
});

describe('column-alignment', () => {
  const table = el({ tag: 'table', role: 'table', rect: { w: 400, h: 100 } });
  const row = (y: number) => el({ parentId: table.id, tag: 'tr', role: 'row', rect: { y, w: 400, h: 20 } });
  const cell = (parent: ElementSnap, x: number, role = 'cell', colSpan = 1) =>
    el({ parentId: parent.id, tag: role === 'cell' ? 'td' : 'th', role, colSpan, rect: { x, y: parent.rect.y, w: 100, h: 20 } });
  it('fails when a body cell left edge differs from the header', () => {
    const head = row(0);
    const body = row(20);
    const s = snap([table, head, cell(head, 0, 'columnheader'), cell(head, 100, 'columnheader'), body, cell(body, 0), cell(body, 130)]);
    const f = checksOf(s, 'column-alignment');
    expect(f).toHaveLength(1);
    expect(f[0]?.detail).toContain('column 2');
  });
  it('passes when aligned and skips colspan rows', () => {
    const head = row(0);
    const body = row(20);
    const span = row(40);
    const s = snap([
      table, head, cell(head, 0, 'columnheader'), cell(head, 100, 'columnheader'),
      body, cell(body, 0), cell(body, 100),
      span, cell(span, 0, 'cell', 2), cell(span, 300),
    ]);
    expect(checksOf(s, 'column-alignment')).toEqual([]);
  });
});

describe('degenerate-control', () => {
  it('fails on a button narrower than 16px', () => {
    expect(checksOf(snap([el({ tag: 'button', rect: { w: 8 } })]), 'degenerate-control')).toHaveLength(1);
  });
  it('fails on a control outside the viewport horizontally', () => {
    expect(checksOf(snap([el({ tag: 'input', rect: { x: 1300, w: 80, h: 24 } })]), 'degenerate-control')).toHaveLength(1);
  });
  it('fails on a [role=tab] shorter than 16px', () => {
    expect(checksOf(snap([el({ role: 'tab', rect: { h: 10 } })]), 'degenerate-control')).toHaveLength(1);
  });
  it('exempts native checkbox and radio boxes', () => {
    const box = el({ tag: 'input', inputType: 'checkbox', rect: { w: 13, h: 13 } });
    expect(checksOf(snap([box]), 'degenerate-control')).toEqual([]);
    expect(checksOf(snap([{ ...box, inputType: 'text' }]), 'degenerate-control')).toHaveLength(1);
  });
  it('passes on a normal control and ignores non-controls', () => {
    expect(checksOf(snap([el({ tag: 'button', rect: { w: 80, h: 24 } }), el({ tag: 'span', rect: { w: 4 } })]), 'degenerate-control')).toEqual([]);
  });
});

describe('ledger', () => {
  const failure = (selector: string): LayoutFailure => ({
    route: 'agents#agents/roles', width: 800, check: 'containment', selector, rects: [], detail: 'x',
  });
  it('fails on a failure that is not in the ledger', () => {
    const r = applyLedger([failure('a')], []);
    expect(r.unexpected).toHaveLength(1);
    expect(r.stale).toEqual([]);
  });
  it('fails on a stale ledger entry that no longer reproduces', () => {
    const r = applyLedger([], [failureKey(failure('gone'))]);
    expect(r.stale).toEqual([failureKey(failure('gone'))]);
  });
  it('passes when the ledger matches exactly', () => {
    const r = applyLedger([failure('a')], [failureKey(failure('a'))]);
    expect(r).toEqual({ unexpected: [], stale: [] });
  });
});
