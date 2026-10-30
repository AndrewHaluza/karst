// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { art, isHidden, mount, q, openedViews, stateWith, text } from './fixtures/artifactsPanelsKit.js';

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#artifacts .artcard')];

afterEach(() => vi.unstubAllGlobals());

describe('Artifacts shelf', () => {
  it('stays hidden and empty before the first snapshot and with no artifact', () => {
    mount(null);
    expect(isHidden('#artPanel')).toBe(true);
    expect(q('#artifacts').childElementCount).toBe(0);
    expect(text('#artTotal')).toBe('');
    mount(stateWith({ artifacts: [] }));
    expect(isHidden('#artPanel')).toBe(true);
    expect(q('#artifacts').childElementCount).toBe(0);
  });

  it('keeps the View all button in the header even while hidden, after the caption', () => {
    mount(null);
    const head = q('#artPanel .phead');
    expect(head.firstChild?.textContent).toBe('Artifacts');
    const button = q<HTMLButtonElement>('#artViewAll');
    expect(button.parentElement).toBe(head);
    expect(button.getAttribute('data-art')).toBe('index');
    expect(button.getAttribute('title')).toBe('Show every artifact this ticket has produced');
    expect(button.className).toBe('k-btn k-btn--ghost k-btn--sm');
  });

  it('shows the semantic total on the button and at most the first three previews, in order', () => {
    mount(stateWith({ artifacts: [art('plan'), art('uat-report'), art('review'), art('ship')] }));
    expect(isHidden('#artPanel')).toBe(false);
    expect(text('#artTotal')).toBe('4');
    expect(q('#artViewAll').textContent).toBe('View all 4 ›');
    expect(cards().map((c) => c.getAttribute('data-art-open'))).toEqual(['plan', 'uat-report', 'review']);
  });

  it('paints the kind glyph and a Stage · vN line on each card, with a generic glyph for an unknown kind', () => {
    vi.stubGlobal('karstIcon', (name: string) => `<svg class="k-icon" width="15" height="15" viewBox="0 0 24 24"><path data-icon="${name}"/></svg>`);
    mount(stateWith({ artifacts: [art('review', { stage: 'review', currentVersionLabel: 'v3' }), art('plan', { stage: 'impl', currentVersionLabel: 'v1' }), art('x', { kind: 'other' as never })] }));
    const [review, plan, other] = cards();
    expect(review!.querySelector('.artcard-stage')!.textContent).toBe('Review · v3');
    expect(plan!.querySelector('.artcard-stage')!.textContent).toBe('Implement · v1');
    expect(review!.querySelector('.artcard-kind path')!.getAttribute('data-icon')).toBe('eye');
    expect(plan!.querySelector('.artcard-kind path')!.getAttribute('data-icon')).toBe('list-tree');
    expect(other!.querySelector('.artcard-kind path')!.getAttribute('data-icon')).toBe('file-text');
  });

  it('paints a card: title, scope, summary, status word, stale flag and origin chip, never a filename', () => {
    mount(
      stateWith({
        artifacts: [art('review', { title: 'Review', scope: 'web', summary: '1 finding', status: 'attention', freshness: 'stale', origin: { kind: 'karst', core: 'codex' } })],
      }),
    );
    const card = cards()[0]!;
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('type')).toBe('button');
    expect(card.getAttribute('aria-label')).toBe('Open Review');
    expect(card.querySelector('.artcard-title')!.textContent).toBe('Review· web');
    expect(card.querySelector('.artcard-title .art-sub')!.textContent).toBe('· web');
    expect(card.querySelector('.artcard-summary')!.textContent).toBe('1 finding');
    expect(card.querySelector('.art-status')!.className).toBe('art-status attention');
    expect(card.querySelector('.art-status')!.textContent).toBe('Needs attention');
    expect(card.querySelector('.art-stale')!.textContent).toBe('Stale');
    expect(card.querySelector('.art-stale')!.getAttribute('title')).toBe('No longer validates the current implementation');
    const origin = card.querySelector('.art-origin')!;
    expect(origin.getAttribute('aria-label')).toBe('karst artifact for Codex');
    expect(origin.querySelector('svg.kmark')).not.toBeNull();
    expect(origin.querySelector('span')!.textContent).toBe('Karst · Codex');
  });

  it.each([
    ['passed', 'Passed', 'passed'],
    ['failed', 'Failed', 'failed'],
    ['info', 'In progress', 'info'],
    ['mystery', 'mystery', 'info'],
  ])('status %s reads %s with class %s', (status, word, cls) => {
    mount(stateWith({ artifacts: [art('plan', { status })] }));
    expect(q('.art-status').textContent).toBe(word);
    expect(q('.art-status').className).toBe(`art-status ${cls}`);
  });

  it('omits the scope and stale flag when absent, and labels a bare karst origin', () => {
    mount(stateWith({ artifacts: [art('plan')] }));
    expect(document.querySelector('.art-sub')).toBeNull();
    expect(document.querySelector('.art-stale')).toBeNull();
    expect(q('.art-origin').getAttribute('aria-label')).toBe('karst artifact');
    expect(q('.art-origin span').textContent).toBe('Karst');
  });

  it('labels a native origin with the core icon and "Native"', () => {
    mount(stateWith({ artifacts: [art('plan', { origin: { kind: 'native', core: 'claude' } })] }));
    const origin = q('.art-origin');
    expect(origin.getAttribute('aria-label')).toBe('Claude Code native artifact');
    expect(origin.textContent).toBe('Claude Code · Native');
    expect(origin.querySelector('svg.kmark')).toBeNull();
  });

  it('falls back to the raw core id when it has no label', () => {
    mount(stateWith({ artifacts: [art('plan', { origin: { kind: 'karst', core: 'zed' } })] }));
    expect(q('.art-origin').getAttribute('aria-label')).toBe('karst artifact for zed');
    expect(q('.art-origin span').textContent).toBe('Karst · zed');
  });

  it('treats a missing origin as a bare karst one', () => {
    mount(stateWith({ artifacts: [art('plan', { origin: undefined })] }));
    expect(q('.art-origin').getAttribute('aria-label')).toBe('karst artifact');
  });

  it('opens the index once from View all', () => {
    mount(stateWith({ artifacts: [art('plan')] }));
    fireEvent.click(q('#artViewAll'));
    expect(openedViews()).toEqual(['index']);
  });

  it('opens the clicked artifact once from a card, whichever child was hit', () => {
    mount(stateWith({ artifacts: [art('plan'), art('review')] }));
    fireEvent.click(cards()[1]!.querySelector('.artcard-summary')!);
    expect(openedViews()).toEqual([{ id: 'review', from: 'ticket' }]);
  });

  it('hides again when the last artifact goes away', () => {
    const h = mount(stateWith({ artifacts: [art('plan')] }));
    h.emit({ type: 'state', state: stateWith({ artifacts: [] }) });
    expect(isHidden('#artPanel')).toBe(true);
    expect(q('#artifacts').childElementCount).toBe(0);
    expect(text('#artTotal')).toBe('');
  });

  it('does not re-render for a push that changes nothing the shelf shows', () => {
    let renders = 0;
    const base = stateWith({ artifacts: [art('plan')] });
    const h = mount(base, () => {
      renders += 1;
    });
    const before = renders;
    h.emit({ type: 'state', state: { ...base, key: 'T-9' } as never });
    expect(renders).toBe(before);
  });
});
