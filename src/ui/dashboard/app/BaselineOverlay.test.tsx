// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { blockedState, all, must, q } from './fixtures/railKit.js';
import { mountOverlays, press, type OverlayHarness } from './fixtures/overlaysKit.js';

const AT = '2026-08-11T14:00:00.000Z';
const png = (n: string): string => `vscode-webview://x/${n}.png`;
const row = (index: number, label: string, decision = 'pending', over: Record<string, unknown> = {}) => ({
  index,
  path: `tests/visual/${label}`,
  label,
  status: 'modified',
  oldSrc: png(`o${index}`),
  newSrc: png(`n${index}`),
  decision,
  reason: null,
  ...over,
});
const ROWS = [
  row(0, 'dark/settings.png'),
  row(1, 'light/settings.png'),
  row(2, 'dark/new.png', 'pending', { status: 'added', oldSrc: null }),
  row(3, 'catalog/gone.png', 'approved', { status: 'deleted', newSrc: null }),
  row(4, 'layout-known-failures.json', 'rejected', { oldSrc: null, newSrc: null, reason: 'ledger grew' }),
];
const review = (rows: unknown[] = ROWS) =>
  blockedState({ kind: 'baseline-review', reason: 'changed', at: AT, resumable: false }, { baselineReview: rows });

const mount = (rows: unknown[] = ROWS): OverlayHarness => {
  const h = mountOverlays(review(rows));
  h.act(() => h.overlays.openBaselines());
  return h;
};
const view = (): HTMLElement => must('#baselineView [data-region="baseline-review"]');
const btn = (act: string, extra = ''): HTMLButtonElement => must<HTMLButtonElement>(`#baselineView [data-act="${act}"]${extra}`);
const selected = (): string | undefined => q('#baselineView .bllist [aria-current="true"]')?.getAttribute('data-index') ?? undefined;
const click = (el: Element): void => void fireEvent.click(el);

describe('BaselineOverlay — shell', () => {
  it('shows the root and swaps the dashboard out while open, and undoes both on close', () => {
    const h = mount();
    expect(must('#baselineView').classList.contains('hidden')).toBe(false);
    expect(document.body.classList.contains('baseline-nav')).toBe(true);
    h.act(() => h.overlays.closeBaselines());
    expect(must('#baselineView').classList.contains('hidden')).toBe(true);
    expect(document.body.classList.contains('baseline-nav')).toBe(false);
  });

  it('focuses itself on open, so the keys work without a click', () => {
    mount();
    expect(document.activeElement).toBe(view());
  });

  it('closes itself when the block clears', () => {
    const h = mount();
    h.emit({ type: 'state', state: blockedState(undefined) });
    expect(h.overlays.getSnapshot().baselines).toBe(false);
    expect(q('#baselineView [data-region="baseline-review"]')).toBeNull();
  });

  it('has Back with a text label, the title, the ticket and stage, and Approve all (n)', () => {
    mount();
    expect(must('#baselineView .dh-backlabel').textContent).toBe('Dashboard');
    expect(must('#baselineView .dh-current').textContent).toBe('Baselines');
    expect(must('#baselineView .blsub').textContent).toContain('3 open');
    expect(btn('baseline-approve', ':not([data-role])').textContent).toContain('Approve all (3)');
    expect(btn('baseline-approve', ':not([data-role])').dataset.indices).toBe('0,1,2');
  });
});

describe('BaselineOverlay — chips and list', () => {
  it('counts every chip and defaults to Needs review', () => {
    mount();
    const chips = all('#baselineView .blchip').map((c) => [c.textContent!.trim(), c.getAttribute('aria-pressed')]);
    expect(chips).toEqual([['Needs review 3', 'true'], ['Rejected 1', 'false'], ['Approved 1', 'false'], ['All 5', 'false']]);
    expect(all('#baselineView .bllist [data-act="baseline-select"]').map((e) => e.getAttribute('data-index'))).toEqual(['0', '1', '2']);
  });

  it('falls back to All when nothing is pending', () => {
    mount([row(0, 'a.png', 'approved'), row(1, 'b.png', 'rejected', { reason: 'x' })]);
    expect(btn('baseline-filter', '[data-filter="all"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('filters locally and posts nothing', () => {
    const h = mount();
    click(btn('baseline-filter', '[data-filter="rejected"]'));
    expect(all('#baselineView .bllist [data-act="baseline-select"]').map((e) => e.getAttribute('data-index'))).toEqual(['4']);
    expect(selected()).toBe('4');
    for (const fn of Object.values(h.send)) expect(fn).not.toHaveBeenCalled();
  });

  it('groups a screenshot by name with one sub-row per theme, each with a glyph and a status word', () => {
    mount();
    const group = must('#baselineView .bllist [role="group"]');
    expect(group.getAttribute('aria-label')).toBe('settings.png');
    expect([...group.querySelectorAll('[data-act="baseline-select"]')].map((e) => e.textContent)).toEqual(['dark' + 'modified', 'light' + 'modified']);
    expect(group.querySelector('.blgroup-head .glyph.wait')!.getAttribute('aria-label')).toBe('Needs review');
    click(btn('baseline-filter', '[data-filter="all"]'));
    expect(must('#baselineView .bllist [data-index="3"] .glyph').className).toContain('pass');
    expect(must('#baselineView .bllist [data-index="4"] .glyph').className).toContain('fail');
  });

  it('selecting an entry shows it in the viewer', () => {
    mount();
    click(btn('baseline-select', '[data-index="1"]'));
    expect(selected()).toBe('1');
    expect(must('#baselineView .blpath-text').textContent).toBe('tests/visual/light/settings.png');
  });

  it('offers the same entries as a native select for the mid width', () => {
    mount();
    const select = must<HTMLSelectElement>('#baselineView .blpicker select');
    expect([...select.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'))).toEqual(['settings.png', 'dark/new.png'.replace('dark/', '')]);
    expect(select.querySelectorAll('option')[0]!.textContent).toBe('dark — modified — Needs review');
    fireEvent.change(select, { target: { value: '1' } });
    expect(selected()).toBe('1');
  });
});

describe('BaselineOverlay — viewer', () => {
  it('defaults to Difference for modified, New for added, Old for deleted', () => {
    mount();
    expect(btn('baseline-view', '[data-view="diff"]').getAttribute('aria-pressed')).toBe('true');
    expect(all('#baselineView .bldiff img').map((i) => i.getAttribute('alt'))).toEqual(['Old dark/settings.png', 'Difference for dark/settings.png']);
    click(btn('baseline-select', '[data-index="2"]'));
    expect(btn('baseline-view', '[data-view="new"]').getAttribute('aria-pressed')).toBe('true');
    click(btn('baseline-filter', '[data-filter="all"]'));
    click(btn('baseline-select', '[data-index="3"]'));
    expect(btn('baseline-view', '[data-view="old"]').getAttribute('aria-pressed')).toBe('true');
    expect(must('#baselineView .blstage img').getAttribute('alt')).toBe('Old catalog/gone.png');
  });

  it('switches Old / New / Difference / Side by side locally, and keeps the choice per entry', () => {
    const h = mount();
    expect(all('#baselineView .blseg button').map((b) => b.textContent)).toEqual(['Old', 'New', 'Difference', 'Side by side']);
    click(btn('baseline-view', '[data-view="sbs"]'));
    expect(all('#baselineView .blsbs figcaption').map((c) => c.textContent)).toEqual(['Old', 'New']);
    click(btn('baseline-select', '[data-index="1"]'));
    expect(btn('baseline-view', '[data-view="diff"]').getAttribute('aria-pressed')).toBe('true');
    click(btn('baseline-select', '[data-index="0"]'));
    expect(btn('baseline-view', '[data-view="sbs"]').getAttribute('aria-pressed')).toBe('true');
    for (const fn of Object.values(h.send)) expect(fn).not.toHaveBeenCalled();
  });

  it('says why an image is missing on the side that has none', () => {
    mount();
    click(btn('baseline-select', '[data-index="2"]'));
    click(btn('baseline-view', '[data-view="old"]'));
    expect(must('#baselineView .blstage .blnote').textContent).toBe('New file — there is no old image.');
    click(btn('baseline-view', '[data-view="diff"]'));
    expect(must('#baselineView .blstage .blnote').textContent).toBe('New file — nothing to compare.');
  });

  it('zooms between fit and 1:1 with a text label', () => {
    mount();
    expect(btn('baseline-zoom').textContent).toContain('Zoom Fit');
    expect(must('#baselineView .blstage').classList.contains('zoom')).toBe(false);
    click(btn('baseline-zoom'));
    expect(btn('baseline-zoom').textContent).toContain('Zoom 1:1');
    expect(must('#baselineView .blstage').classList.contains('zoom')).toBe(true);
  });

  it('says there is no preview for a file that is not an image, and shows the rejection reason', () => {
    mount();
    click(btn('baseline-filter', '[data-filter="rejected"]'));
    expect(must('#baselineView .blviewer').textContent).toContain('No preview for this file type — open it from Source Control.');
    expect(must('#baselineView .blviewer').textContent).toContain('Rejected: ledger grew');
    expect(q('#baselineView .blseg')).toBeNull();
  });
});

describe('BaselineOverlay — action bar', () => {
  it('Approve posts the block id and the entry index once, and moves to the next pending entry', () => {
    const h = mount();
    const approve = btn('baseline-approve', '[data-role="approve"]');
    click(approve);
    click(approve);
    expect(h.send.baselineApprove).toHaveBeenCalledTimes(1);
    expect(h.send.baselineApprove).toHaveBeenCalledWith('baseline-review', [0], 'req-1');
    expect(selected()).toBe('1');
  });

  it('offers "Approve k themes" only when the screenshot has more than one pending theme', () => {
    const h = mount();
    const group = btn('baseline-approve', ':not([data-role])[data-indices="0,1"]');
    expect(group.textContent).toContain('Approve 2 themes');
    click(group);
    expect(h.send.baselineApprove).toHaveBeenCalledWith('baseline-review', [0, 1], 'req-1');
    expect(selected()).toBe('2');
    expect(q('#baselineView [data-indices="2"]:not([data-role])')).toBeNull();
    expect(all('#baselineView .blactions [data-act="baseline-approve"]')).toHaveLength(1);
  });

  it('Approve all (n) in the header posts every pending entry', () => {
    const h = mount();
    click(btn('baseline-approve', '[data-indices="0,1,2"]'));
    expect(h.send.baselineApprove).toHaveBeenCalledWith('baseline-review', [0, 1, 2], 'req-1');
  });

  it('hides Approve for an approved entry and Reject for a rejected one', () => {
    mount();
    click(btn('baseline-filter', '[data-filter="approved"]'));
    expect(q('#baselineView [data-role="approve"]')).toBeNull();
    expect(q('#baselineView [data-act="baseline-reject-open"]')).not.toBeNull();
    click(btn('baseline-filter', '[data-filter="rejected"]'));
    expect(q('#baselineView [data-act="baseline-reject-open"]')).toBeNull();
    expect(q('#baselineView [data-role="approve"]')).not.toBeNull();
  });

  it('steps with Prev and Next and shows i / n; the ends are disabled', () => {
    mount();
    expect(must('#baselineView .blpos').textContent).toBe('1 / 3');
    expect(btn('baseline-prev').disabled).toBe(true);
    click(btn('baseline-next'));
    expect(selected()).toBe('1');
    expect(must('#baselineView .blpos').textContent).toBe('2 / 3');
    click(btn('baseline-next'));
    expect(btn('baseline-next').disabled).toBe(true);
    click(btn('baseline-prev'));
    expect(selected()).toBe('1');
  });

  it('keeps the labels Approve, Reject, Prev and Next', () => {
    mount();
    expect(all('#baselineView .blact .k-btn').map((b) => b.textContent!.trim())).toEqual(['Prev', 'Next', 'Reject', 'Approve 2 themes', 'Approve']);
  });
});

describe('BaselineOverlay — reject form', () => {
  it('opens a focused required reason field in the action bar; an empty reason names the field and posts nothing', () => {
    const h = mount();
    click(btn('baseline-reject-open'));
    const ta = must<HTMLTextAreaElement>('#blreason-0');
    expect(document.activeElement).toBe(ta);
    expect(ta.required).toBe(true);
    expect(must('label[for="blreason-0"]').textContent).toBe('Why is this wrong? The fix agent reads this.');
    expect(q('#baselineView [data-act="baseline-reject-open"]')).toBeNull();
    const send = btn('baseline-reject');
    click(send);
    expect(h.send.baselineReject).not.toHaveBeenCalled();
    expect(send.hasAttribute('aria-busy')).toBe(false);
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    expect(must('#blreason-err-0').textContent).toBe('A reason is required.');
    expect(must('#blreason-err-0').getAttribute('role')).toBe('alert');
  });

  it('posts the trimmed reason with the entry index, once', () => {
    const h = mount();
    click(btn('baseline-reject-open'));
    fireEvent.input(must('#blreason-0'), { target: { value: '  button is clipped  ' } });
    const send = btn('baseline-reject');
    click(send);
    click(send);
    expect(h.send.baselineReject).toHaveBeenCalledTimes(1);
    expect(h.send.baselineReject).toHaveBeenCalledWith('baseline-review', 0, 'button is clipped', 'req-1');
  });

  it('Cancel closes the form and keeps the draft, also across closing and reopening the overlay and a live push', () => {
    const h = mount();
    click(btn('baseline-reject-open'));
    fireEvent.input(must('#blreason-0'), { target: { value: 'half a thought' } });
    h.emit({ type: 'state', state: review(), live: true });
    expect(must<HTMLTextAreaElement>('#blreason-0').value).toBe('half a thought');
    click(btn('baseline-reject-cancel'));
    expect(q('#blreason-0')).toBeNull();
    h.act(() => h.overlays.closeBaselines());
    h.act(() => h.overlays.openBaselines());
    click(btn('baseline-reject-open'));
    expect(must<HTMLTextAreaElement>('#blreason-0').value).toBe('half a thought');
  });
});

describe('BaselineOverlay — keys and Escape', () => {
  const key = (k: string, init: KeyboardEventInit = {}, target: Element = view()): KeyboardEvent => press(k, init, target);

  it('J and K step, A approves, R opens the reject form', () => {
    const h = mount();
    key('j');
    expect(selected()).toBe('1');
    key('k');
    expect(selected()).toBe('0');
    key('a');
    expect(h.send.baselineApprove).toHaveBeenCalledWith('baseline-review', [0], 'req-1');
    key('R');
    expect(q('#blreason-1')).not.toBeNull();
  });

  it('ignores a modified key, a repeat and a key typed in the reason field', () => {
    const h = mount();
    key('j', { ctrlKey: true });
    key('j', { metaKey: true });
    key('j', { altKey: true });
    key('j', { repeat: true });
    expect(selected()).toBe('0');
    click(btn('baseline-reject-open'));
    const ta = must('#blreason-0');
    key('a', {}, ta);
    key('j', {}, ta);
    expect(h.send.baselineApprove).not.toHaveBeenCalled();
    expect(selected()).toBe('0');
  });

  it('does nothing when focus is outside the overlay', () => {
    const h = mount();
    press('a', {}, document.body);
    expect(h.send.baselineApprove).not.toHaveBeenCalled();
  });

  it('Escape closes the reject form first, then the overlay', () => {
    const h = mount();
    click(btn('baseline-reject-open'));
    expect(key('Escape', {}, must('#blreason-0')).defaultPrevented).toBe(true);
    expect(q('#blreason-0')).toBeNull();
    expect(h.overlays.getSnapshot().baselines).toBe(true);
    expect(key('Escape').defaultPrevented).toBe(true);
    expect(h.overlays.getSnapshot().baselines).toBe(false);
  });
});
