// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { art, isHidden, mount, q, openedViews, stateWith, stored, text } from './fixtures/artifactsPanelsKit.js';

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#artifacts .artcard')];

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

describe('Captured artifacts panel', () => {
  it('stays hidden and empty until the host answered', () => {
    mount(stateWith({}));
    expect(isHidden('#storedPanel')).toBe(true);
    expect(q('#storedSummary').childElementCount).toBe(0);
    expect(text('#storedTotal')).toBe('');
  });

  it('keeps the Open button in the header even while hidden', () => {
    mount(null);
    const button = q<HTMLButtonElement>('#storedOpen');
    expect(button.parentElement).toBe(q('#storedPanel .phead'));
    expect(button.getAttribute('data-art')).toBe('stored');
    expect(button.getAttribute('title')).toBe('Browse captured output files and their revision history');
    expect(button.className).toBe('k-btn k-btn--ghost k-btn--sm');
  });

  it('summarises the count per kind, in order, with the total on the button', () => {
    mount(stateWith({ storedArtifacts: stored([['screenshot', 2], ['plan', 1]]) }));
    expect(isHidden('#storedPanel')).toBe(false);
    expect(q('#storedOpen').textContent).toBe('Open 3 ›');
    expect(q('#storedSummary').children).toHaveLength(1);
    expect(q('#storedSummary .sa-meta').textContent).toBe('screenshot 2 · plan 1');
  });

  it('counts rows across every approach of a kind', () => {
    const view = stored([], 3);
    view.groups = [{ kind: 'plan', approaches: [{ approach: 'a', rows: [{} as never, {} as never] }, { approach: 'b', rows: [{} as never] }] }];
    mount(stateWith({ storedArtifacts: view }));
    expect(q('#storedSummary .sa-meta').textContent).toBe('plan 3');
  });

  it('says nothing was captured when the total is zero', () => {
    mount(stateWith({ storedArtifacts: stored([], 0) }));
    expect(isHidden('#storedPanel')).toBe(false);
    expect(q('#storedSummary .sa-empty').textContent).toBe('Nothing captured yet.');
    expect(text('#storedTotal')).toBe('0');
  });

  it('opens the stored view once from Open', () => {
    mount(stateWith({ storedArtifacts: stored([['plan', 1]]) }));
    fireEvent.click(q('#storedOpen'));
    expect(openedViews()).toEqual(['stored']);
  });

  it('hides again when the stored view disappears', () => {
    const h = mount(stateWith({ storedArtifacts: stored([['plan', 1]]) }));
    h.emit({ type: 'state', state: stateWith({}) });
    expect(isHidden('#storedPanel')).toBe(true);
    expect(q('#storedSummary').childElementCount).toBe(0);
  });
});
