// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, blockedState, cleanupRail, must, mountRail, q } from './fixtures/railKit.js';

installRuntimeDoubles();
afterEach(cleanupRail);

type Trigger = 'gate-failure' | 'blocking-review-findings' | 'blocking-tester-observations';
const REASON = 'second no-change verdict on the same head';
const park = (over: Record<string, unknown> = {}) => ({ sourceStage: 'uat', trigger: 'gate-failure' as Trigger, reason: REASON, items: ['[high] t (f.ts:1)'], ...over });
const parked = (fixPark: unknown = park()) =>
  blockedState(undefined, { stageCurrent: 'fix', currentStage: { stageKey: 'fix', status: 'failed' }, fixPark });
const banner = (): HTMLElement => must('#blocked');
const shown = (): boolean => !banner().classList.contains('hidden');
const text = (sel: string): string => q(`#blocked ${sel}`)?.textContent ?? '';
const btn = (act: string): HTMLButtonElement => must<HTMLButtonElement>(`#blocked [data-act="${act}"]`);
const maybe = (act: string): HTMLButtonElement | null => q<HTMLButtonElement>(`#blocked [data-act="${act}"]`);

describe('FixParkBanner (a parked fix round)', () => {
  it.each([
    ['gate-failure', 'uat', 'The uat gate still fails'],
    ['blocking-review-findings', 'review', 'Review findings stay open'],
    ['blocking-tester-observations', 'uat', 'Tester observations stay open'],
  ] as const)('a parked %s round shows both buttons', (trigger, sourceStage, title) => {
    mountRail(parked(park({ trigger, sourceStage })));
    expect(shown()).toBe(true);
    expect(q("#blocked [data-region=\"blocked-banner\"]")).not.toBeNull();
    expect(text('.ftitle')).toBe(title);
    expect(text('.freason')).toContain(REASON);
    expect(btn('fix-parked-retry').textContent).toBe('Retry gate');
    expect(btn('fix-parked-accept').textContent).toBe('Accept and continue');
    for (const act of ['fix-parked-retry', 'fix-parked-accept']) {
      expect(btn(act).dataset.stagekey).toBe(sourceStage);
      expect(btn(act).className).toContain('k-btn--sm');
    }
  });

  it('lists the items of the round', () => {
    mountRail(parked(park({ items: ['a', 'b', 'c', 'd', 'e'] })));
    expect(all('#blocked li').map((li) => li.textContent)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('Retry gate posts once with a request id and goes pending', () => {
    const h = mountRail(parked());
    const b = btn('fix-parked-retry');
    fireEvent.click(b);
    fireEvent.click(b);
    expect(h.send.fixParkedRetry).toHaveBeenCalledTimes(1);
    expect(h.send.fixParkedRetry).toHaveBeenCalledWith('req-1');
    expect(b.classList.contains('is-pending')).toBe(true);
  });

  it('Accept opens the note form; the confirm posts the note once and goes pending', () => {
    const h = mountRail(parked());
    expect(maybe('fix-parked-accept-confirm')).toBeNull();
    fireEvent.click(btn('fix-parked-accept'));
    expect(text('label')).toBe('Note (optional)');
    fireEvent.input(must<HTMLTextAreaElement>('#blocked textarea'), { target: { value: 'known limit' } });
    const confirm = btn('fix-parked-accept-confirm');
    expect(confirm.dataset.stagekey).toBe('uat');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(h.send.fixParkedAccept).toHaveBeenCalledTimes(1);
    expect(h.send.fixParkedAccept).toHaveBeenCalledWith('known limit', 'req-1');
    expect(confirm.classList.contains('is-pending')).toBe(true);
  });

  it('Accept with a blank note posts an empty note', () => {
    const h = mountRail(parked());
    fireEvent.click(btn('fix-parked-accept'));
    fireEvent.click(btn('fix-parked-accept-confirm'));
    expect(h.send.fixParkedAccept).toHaveBeenCalledWith('', 'req-1');
  });

  it('Cancel closes the form and posts nothing', () => {
    const h = mountRail(parked());
    fireEvent.click(btn('fix-parked-accept'));
    fireEvent.click(btn('fix-parked-accept-cancel'));
    expect(maybe('fix-parked-accept-confirm')).toBeNull();
    expect(maybe('fix-parked-retry')).not.toBeNull();
    expect(h.send.fixParkedAccept).not.toHaveBeenCalled();
    expect(vi.isMockFunction(h.send.fixParkedRetry)).toBe(true);
  });

  it('shows no banner when fixPark is null and there is no block', () => {
    mountRail(parked(null));
    expect(shown()).toBe(false);
    expect(banner().childElementCount).toBe(0);
  });

  it('keeps the block banner when a block is also present', () => {
    mountRail({ ...parked(), currentStage: { stageKey: 'fix', status: 'failed', blocked: { kind: 'boot-failed', reason: 'x', at: '2026-08-11T14:00:00.000Z', resumable: true } } } as never);
    expect(maybe('fix-parked-retry')).toBeNull();
    expect(btn('stage-resume')).not.toBeNull();
  });
});
