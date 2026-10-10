import { describe, expect, it } from 'vitest';
import {
  runChecks,
  stateSurvivesResize,
  type RegionExpectation,
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
    hasText: true,
    region: null,
    primaryAction: false,
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
  it('fails on an icon-only control under 24x24', () => {
    expect(checksOf(snap([el({ tag: 'button', hasText: false, rect: { w: 20, h: 20 } })]), 'degenerate-control')).toHaveLength(1);
  });
  it('passes an icon-only control at 24x24', () => {
    expect(checksOf(snap([el({ tag: 'button', hasText: false, rect: { w: 24, h: 24 } })]), 'degenerate-control')).toEqual([]);
  });
  it('fails a text control under 20px high, passes it at 20px', () => {
    expect(checksOf(snap([el({ tag: 'button', rect: { w: 80, h: 19 } })]), 'degenerate-control')).toHaveLength(1);
    expect(checksOf(snap([el({ tag: 'button', rect: { w: 80, h: 20 } })]), 'degenerate-control')).toEqual([]);
  });
  it('fails on a control outside the viewport horizontally', () => {
    expect(checksOf(snap([el({ tag: 'input', rect: { x: 1300, w: 80, h: 24 } })]), 'degenerate-control')).toHaveLength(1);
  });
  it('fails on a [role=tab] shorter than 20px', () => {
    expect(checksOf(snap([el({ role: 'tab', rect: { h: 10 } })]), 'degenerate-control')).toHaveLength(1);
  });
  it('exempts native checkbox and radio boxes', () => {
    const box = el({ tag: 'input', inputType: 'checkbox', rect: { w: 13, h: 13 } });
    expect(checksOf(snap([box]), 'degenerate-control')).toEqual([]);
    expect(checksOf(snap([{ ...box, inputType: 'text' }]), 'degenerate-control')).toHaveLength(1);
  });
  it('ignores non-controls', () => {
    expect(checksOf(snap([el({ tag: 'span', rect: { w: 4 } })]), 'degenerate-control')).toEqual([]);
  });
});

describe('scroller', () => {
  const pane = el({ region: 'list', rect: { x: 0, y: 0, w: 400, h: 400 } });
  const scroller = (over: Omit<Partial<ElementSnap>, 'rect'> & { rect?: Partial<ElementSnap['rect']> } = {}) =>
    el({ parentId: pane.id, overflowY: 'auto', scrollH: 900, clientH: 300, rect: { x: 0, y: 0, w: 400, h: 300 }, ...over });
  it('passes one scroller inside its pane and the viewport', () => {
    expect(checksOf(snap([pane, scroller()]), 'scroller')).toEqual([]);
  });
  it('fails a scroller that extends past its pane', () => {
    const f = checksOf(snap([pane, scroller({ rect: { w: 500 } })]), 'scroller');
    expect(f).toHaveLength(1);
    expect(f[0]?.detail).toContain('pane');
  });
  it('fails a scroller outside the viewport', () => {
    const f = checksOf(snap([scroller({ parentId: null, rect: { x: 1200, w: 300 } })]), 'scroller');
    expect(f[0]?.detail).toContain('viewport');
  });
  it('fails a second scroller in the same pane', () => {
    const f = checksOf(snap([pane, scroller(), scroller()]), 'scroller');
    expect(f).toHaveLength(1);
    expect(f[0]?.detail).toContain('second scroll container');
  });
  it('allows one scroller per pane', () => {
    const other = el({ region: 'detail', rect: { x: 400, y: 0, w: 400, h: 400 } });
    const second = scroller({ parentId: other.id, rect: { x: 400 } });
    expect(checksOf(snap([pane, other, scroller(), second]), 'scroller')).toEqual([]);
  });
  it('ignores overflow:auto that does not overflow', () => {
    expect(checksOf(snap([pane, scroller({ scrollH: 300 }), scroller({ scrollH: 300 })]), 'scroller')).toEqual([]);
  });
});

describe('section-spacing', () => {
  const parent = el({ rect: { w: 400, h: 400 } });
  const section = (y: number, h = 100) => el({ tag: 'section', parentId: parent.id, rect: { y, w: 400, h } });
  const item = (s: ElementSnap, y: number) => el({ parentId: s.id, rect: { y, w: 100, h: 10 } });
  it('passes when sections are further apart than their items', () => {
    const a = section(0);
    const b = section(140);
    expect(checksOf(snap([parent, a, item(a, 0), item(a, 20), b, item(b, 140)]), 'section-spacing')).toEqual([]);
  });
  it('fails when the section gap equals the item gap', () => {
    const a = section(0, 100);
    const b = section(110, 100);
    const f = checksOf(snap([parent, a, item(a, 0), item(a, 20), b, item(b, 110)]), 'section-spacing');
    expect(f).toHaveLength(1);
    expect(f[0]?.detail).toContain('not larger');
  });
});

describe('region-order', () => {
  const region = (name: string, x: number, y: number) => el({ region: name, rect: { x, y, w: 200, h: 100 } });
  const side: RegionExpectation = { layout: 'side-by-side', order: ['list', 'detail'] };
  const stacked: RegionExpectation = { layout: 'stacked', order: ['list', 'detail'] };
  const run = (els: ElementSnap[], expected?: RegionExpectation) =>
    runChecks(snap(els), expected).filter((f) => f.check === 'region-order');
  it('reports nothing without an expectation', () => {
    expect(run([region('list', 0, 0)])).toEqual([]);
  });
  it('passes side-by-side regions in order', () => {
    expect(run([region('list', 0, 0), region('detail', 200, 0)], side)).toEqual([]);
  });
  it('fails side-by-side regions in the wrong order', () => {
    expect(run([region('list', 200, 0), region('detail', 0, 0)], side)).toHaveLength(1);
  });
  it('passes stacked regions and fails when they sit side by side', () => {
    expect(run([region('list', 0, 0), region('detail', 0, 100)], stacked)).toEqual([]);
    expect(run([region('list', 0, 0), region('detail', 200, 0)], stacked)).toHaveLength(1);
  });
  it('fails a missing region', () => {
    expect(run([region('list', 0, 0)], side)[0]?.detail).toContain('"detail" is not rendered');
  });
  it('fails a primary action outside header/toolbar and passes one inside', () => {
    const header = region('header', 0, 0);
    const body = region('detail', 0, 100);
    const inHeader = el({ parentId: header.id, primaryAction: true, rect: { w: 80, h: 24 } });
    const inBody = el({ parentId: body.id, primaryAction: true, rect: { y: 110, w: 80, h: 24 } });
    const expected: RegionExpectation = { layout: 'stacked', order: ['header', 'detail'] };
    expect(run([header, body, inHeader], expected)).toEqual([]);
    expect(run([header, body, inBody], expected)[0]?.detail).toContain('"detail"');
  });
});

describe('state-survives-resize', () => {
  it('passes when hash and selection are unchanged', () => {
    const s = { hash: '#agents/roles/uatTester', selected: 'uatTester' };
    expect(stateSurvivesResize(s, { ...s })).toEqual([]);
  });
  it('fails when the hash or the selection changes', () => {
    const before = { hash: '#agents/roles/uatTester', selected: 'uatTester' };
    const f = stateSurvivesResize(before, { hash: '#agents/roles', selected: null });
    expect(f).toHaveLength(1);
    expect(f[0]?.detail).toContain('hash');
    expect(f[0]?.detail).toContain('selected');
  });
});
