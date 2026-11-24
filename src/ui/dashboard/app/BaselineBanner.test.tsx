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
    expect(btn('baseline-approve-all').className).toContain('k-btn--secondary');
    expect(btn('baseline-approve-all').textContent).toContain('Approve all');
  });

  it('approves the pending entries only, not the rejected ones, without a confirm', () => {
    const h = mountRail(review([row(0, 'pending'), row(1, 'rejected', { reason: 'x' }), row(2, 'approved'), row(3, 'pending')]));
    fireEvent.click(btn('baseline-approve-all'));
    // The message names the block only: the host decides what is pending, so no index list or size limit applies.
    expect(h.send.baselineApproveAll).toHaveBeenCalledWith('baseline-review', 'req-1');
    expect(h.send.baselineApprove).not.toHaveBeenCalled();
  });

  it('hides Approve all when nothing is pending, and says so in the singular', () => {
    mountRail(review([row(0, 'approved'), row(1, 'rejected', { reason: 'x' })]));
    expect(q('#blocked [data-act="baseline-approve-all"]')).toBeNull();
    expect(banner().querySelector('.freason')!.textContent).toContain('0 of 2 changed screenshots need you');
    cleanupRail();
    mountRail(review([row(0, 'pending')]));
    expect(banner().querySelector('.freason')!.textContent).toContain('1 of 1 changed screenshot needs you');
  });

  it('counts two rejections in the line and offers Send 2 rejections to fix', () => {
    mountRail(review([row(0, 'rejected', { reason: 'a' }), row(1, 'rejected', { reason: 'b' }), row(2, 'pending')]));
    expect(banner().querySelector('.freason')!.textContent).toContain('· 2 rejected');
    expect(btn('baseline-send-rejections').className).toContain('k-btn--danger');
    expect(btn('baseline-send-rejections').textContent).toContain('Send 2 rejections to fix');
    expect(btn('baseline-send-rejections').getAttribute('data-block-id')).toBe('baseline-review');
  });

  it('says Approve all also sends the rejections, and posts Send with the block id once', () => {
    const h = mountRail(review([row(0, 'pending'), row(1, 'rejected', { reason: 'x' })]));
    expect(btn('baseline-approve-all').textContent).toContain('Approve 1 and send 1 to fix');
    fireEvent.click(btn('baseline-send-rejections'));
    fireEvent.click(btn('baseline-send-rejections'));
    expect(h.send.baselineSendRejections).toHaveBeenCalledTimes(1);
    expect(h.send.baselineSendRejections).toHaveBeenCalledWith('baseline-review', 'req-1');
  });

  it('hides Send when nothing is rejected', () => {
    mountRail(review([row(0, 'pending'), row(1, 'approved')]));
    expect(q('#blocked [data-act="baseline-send-rejections"]')).toBeNull();
    expect(btn('baseline-approve-all').textContent).toContain('Approve all');
  });

  it('allowlists the enums and coerces the index', () => {
    mountRail(review([row(7.9, 'odd', { status: 'weird' })]));
    expect(all('#blocked .blbanner')).toHaveLength(1);
  });
});
