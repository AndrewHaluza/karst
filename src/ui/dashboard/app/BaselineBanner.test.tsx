// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, blockedState, cleanupRail, must, mountRail, q } from './fixtures/railKit.js';

installRuntimeDoubles();
afterEach(cleanupRail);

const row = (index: number, decision: string, over: Record<string, unknown> = {}) => ({
  index,
  path: `tests/visual/${index}.png`,
  label: `dark/${index}.png`,
  status: 'modified',
  oldSrc: 'o.png',
  newSrc: 'n.png',
  decision,
  reason: null,
  ...over,
});
const review = (rows: unknown[]) =>
  blockedState({ kind: 'baseline-review', reason: 'changed', at: '2026-08-11T14:00:00.000Z', resumable: false }, { baselineReview: rows });
const banner = (): HTMLElement => must('#blocked');
const btn = (act: string): HTMLButtonElement => must<HTMLButtonElement>(`#blocked [data-act="${act}"]`);

describe('BaselineBanner (@arch:BASELINE-REVIEW)', () => {
  it('is one line: the wait glyph, the title and the open count, with no rows', () => {
    mountRail(review([row(0, 'pending'), row(1, 'pending'), row(2, 'approved')]));
    expect(banner().querySelector('.blbanner')).not.toBeNull();
    expect(banner().querySelector('.ftitle')!.textContent).toBe('Review baselines');
    expect(banner().querySelector('.freason')!.textContent).toContain('2 of 3 changed screenshots need you');
    expect(banner().querySelector('.glyph.wait')!.getAttribute('aria-label')).toBe('Needs review');
    expect(q('#blocked .blrow')).toBeNull();
    expect(q('#blocked [data-act="stage-resume"]')).toBeNull();
  });

  it('adds the rejected count only when there is one', () => {
    mountRail(review([row(0, 'pending'), row(1, 'rejected', { reason: 'bad' })]));
    expect(banner().querySelector('.freason')!.textContent).toContain('1 of 2 changed screenshots need you · 1 rejected');
    cleanupRail();
    mountRail(review([row(0, 'pending')]));
    expect(banner().querySelector('.freason')!.textContent).not.toContain('rejected');
  });

  it('offers Review as the primary button, and Approve all as the secondary one', () => {
    mountRail(review([row(0, 'pending')]));
    expect(btn('baseline-open').className).toContain('k-btn--primary');
    expect(btn('baseline-open').textContent).toContain('Review');
    expect(btn('baseline-approve').className).toContain('k-btn--secondary');
    expect(btn('baseline-approve').textContent).toContain('Approve all');
  });

  it('approves the pending entries only, not the rejected ones, without a confirm', () => {
    const h = mountRail(review([row(0, 'pending'), row(1, 'rejected', { reason: 'x' }), row(2, 'approved'), row(3, 'pending')]));
    expect(btn('baseline-approve').dataset.indices).toBe('0,3');
    fireEvent.click(btn('baseline-approve'));
    expect(h.send.baselineApprove).toHaveBeenCalledWith('baseline-review', [0, 3], 'req-1');
  });

  it('hides Approve all when nothing is pending, and says so in the singular', () => {
    mountRail(review([row(0, 'approved'), row(1, 'rejected', { reason: 'x' })]));
    expect(q('#blocked [data-act="baseline-approve"]')).toBeNull();
    expect(banner().querySelector('.freason')!.textContent).toContain('0 of 2 changed screenshots need you');
    cleanupRail();
    mountRail(review([row(0, 'pending')]));
    expect(banner().querySelector('.freason')!.textContent).toContain('1 of 1 changed screenshot needs you');
  });

  it('allowlists the enums and coerces the index', () => {
    mountRail(review([row(7.9, 'odd', { status: 'weird' })]));
    expect(btn('baseline-approve').dataset.indices).toBe('7');
    expect(all('#blocked .blbanner')).toHaveLength(1);
  });
});
