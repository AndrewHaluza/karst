// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { installRuntimeDoubles, settled } from './fixtures/prsPanelKit.js';
import { cleanupRail, go, mainLine, must, mountRail, needs, q, railState, REPO } from './fixtures/railKit.js';

installRuntimeDoubles();
afterEach(cleanupRail);

const text = (el: Element | null): string => el?.textContent ?? '';

describe('Rail — the needs-you control acts or navigates, as the host says', () => {
  const ship = (cta: unknown, over = {}) =>
    railState({ main: mainLine('ship', { ship: { needsUser: true, needs: needs(cta as never, { action: 'Go', ...over }) } }), stageCurrent: 'ship' });

  it('Ship posts the payload-free message once and holds busy until the stage leaves ship', () => {
    const h = mountRail(ship({ kind: 'ship-confirm' }));
    expect(go().dataset.act).toBe('ship-ticket');
    fireEvent.click(go());
    fireEvent.click(go());
    expect(h.send.shipTicket).toHaveBeenCalledTimes(1);
    expect(h.send.shipTicket).toHaveBeenCalledWith();
    expect(go().getAttribute('aria-busy')).toBe('true');
    expect(go().disabled).toBe(true);
    expect(h.ops().getSnapshot().shipping).toBe(true);
    // Still at ship, running: held across the push.
    h.emit({ type: 'state', state: railState({ stageCurrent: 'ship', currentStage: { stageKey: 'ship', status: 'running' }, main: mainLine('ship', { ship: { needsUser: true, needs: needs({ kind: 'ship-confirm' }) } }) }) });
    expect(go().getAttribute('aria-busy')).toBe('true');
    expect(settled).toEqual([]);
    // Left ship: success.
    h.emit({ type: 'state', state: railState({ stageCurrent: 'done' }) });
    expect(settled).toEqual([['req-1', true, undefined]]);
    expect(q('#rail .go')).toBeNull();
  });

  it('shows Ship busy when the header started it (one request, one dialog)', () => {
    const h = mountRail(ship({ kind: 'ship-confirm' }));
    act(() => h.ops().beginShip('req-header'));
    expect(go().getAttribute('aria-busy')).toBe('true');
    expect(go().disabled).toBe(true);
    fireEvent.click(go());
    expect(h.send.shipTicket).not.toHaveBeenCalled();
  });

  it('Merge posts exactly {repo} once with no request id, and is busy for that repo only', () => {
    const h = mountRail(ship({ kind: 'merge', repo: REPO }));
    expect(go().dataset.act).toBe('merge-pr');
    expect(go().dataset.repo).toBe(REPO);
    fireEvent.click(go());
    fireEvent.click(go());
    expect(h.send.mergePr).toHaveBeenCalledTimes(1);
    expect(h.send.mergePr.mock.calls[0]).toEqual([REPO]);
    expect(go().getAttribute('aria-busy')).toBe('true');
    expect(h.ops().getSnapshot().merging.has(REPO)).toBe(true);
  });

  it('Merge is busy when the PR panel started it', () => {
    const h = mountRail(ship({ kind: 'merge', repo: REPO }));
    act(() => h.ops().beginMerge(REPO, 'req-panel'));
    expect(go().getAttribute('aria-busy')).toBe('true');
    fireEvent.click(go());
    expect(h.send.mergePr).not.toHaveBeenCalled();
  });

  it('Resolve conflicts posts the repo with a request id once and goes pending', () => {
    const h = mountRail(ship({ kind: 'resolve-conflicts', repo: REPO }));
    expect(go().dataset.act).toBe('resolve-conflicts');
    fireEvent.click(go());
    fireEvent.click(go());
    expect(h.send.resolveConflicts).toHaveBeenCalledTimes(1);
    expect(h.send.resolveConflicts).toHaveBeenCalledWith(REPO, 'req-1');
    expect(go().getAttribute('aria-busy')).toBe('true');
  });

  it.each([['merge-panel'], ['resolve-panel'], ['graph-panel'], ['open-session']])('%s navigates, posting nothing', (kind) => {
    const h = mountRail(ship({ kind }));
    expect(go().hasAttribute('data-act')).toBe(false);
    expect(go().hasAttribute('data-goto')).toBe(true);
    expect(go().dataset.go).toBe(kind);
    fireEvent.click(go());
    for (const fn of Object.values(h.send)) expect(fn).not.toHaveBeenCalled();
  });

  it('a host verdict without a call to action opens the session', () => {
    mountRail(ship(undefined));
    expect(go().dataset.go).toBe('open-session');
  });

  it('labels the control with the host wording, or Open when there is none', () => {
    mountRail(ship({ kind: 'open-session' }, { action: 'Resume it' }));
    expect(text(go())).toBe('Resume it');
  });
});

describe('Rail — navigation targets', () => {
  const scrolled: Element[] = [];
  const stub = (): void => {
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    scrolled.length = 0;
  };
  const navState = (kind: string) => railState({ main: mainLine('ship', { ship: { needsUser: true, needs: needs({ kind } as never) } }), stageCurrent: 'ship' });

  it.each([
    ['merge-panel', '#panelMerge'],
    ['resolve-panel', '#panelMerge'],
    ['open-session', '#agentButton'],
    ['graph-panel', '#inside'],
  ])('%s scrolls the owning control into view and focuses it', (kind, target) => {
    stub();
    mountRail(navState(kind));
    fireEvent.click(go());
    expect(scrolled).toEqual([must(target)]);
    if (kind !== 'graph-panel') expect(document.activeElement).toBe(must(target));
  });

  it('falls back to the panel when it has no control yet', () => {
    stub();
    mountRail(navState('merge-panel'));
    must('#panelMerge').remove();
    fireEvent.click(go());
    expect(scrolled).toEqual([must('#prs')]);
  });
});
