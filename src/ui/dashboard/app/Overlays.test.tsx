// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DashboardState } from '../state.js';
import { mountOverlays, must, press, type OverlayHarness } from './fixtures/overlaysKit.js';
import { stateWithArtifacts } from './fixtures/artifactFixtures.js';

const state = (): DashboardState => stateWithArtifacts({ brief: 'b', envOverrides: { services: [], values: {} } });

const escapeOn = (target: EventTarget = document.body): KeyboardEvent => press('Escape', {}, target);
const openAll = (h: OverlayHarness): void => {
  vi.stubGlobal('createServerLogsView', () => ({ open: vi.fn(), close: vi.fn(), handleInitial: vi.fn(), handleOutput: vi.fn() }));
  h.act(() => {
    h.overlays.openIndex();
    h.overlays.openEnv();
    h.overlays.openLogs();
    h.overlays.openConsole('uat', null);
    h.overlays.openTicketData();
  });
};
const open = (h: OverlayHarness): string[] => {
  const s = h.overlays.getSnapshot();
  return [s.drawer && 'drawer', s.console && 'console', s.logs && 'logs', s.env && 'env', s.art && 'art'].filter(Boolean) as string[];
};

describe('Overlays — the one Escape owner', () => {
  it('registers a single page-level key handler', () => {
    const add = vi.spyOn(document, 'addEventListener');
    mountOverlays(state());
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    add.mockRestore();
  });

  it('closes the drawer, then walks back through console, logs, env editor and artifact view, claiming each Escape', () => {
    const h = mountOverlays(state());
    openAll(h);
    expect(open(h)).toEqual(['drawer', 'console']);
    const trail: string[][] = [];
    for (let i = 0; i < 5; i++) {
      expect(escapeOn().defaultPrevented).toBe(true);
      trail.push(open(h));
    }
    expect(trail).toEqual([['console'], ['logs'], ['env'], ['art'], []]);
    expect(escapeOn().defaultPrevented).toBe(false);
  });

  it('leaves the Escape to the stage menu, after the drawer and before anything else', () => {
    const h = mountOverlays(state());
    h.act(() => {
      h.overlays.openIndex();
      h.overlays.openTicketData();
      h.overlays.setStageMenuOpen(true);
    });
    expect(escapeOn().defaultPrevented).toBe(true);
    expect(open(h)).toEqual(['art']);
    expect(escapeOn().defaultPrevented).toBe(false); // the menu's own handler closes the menu
    expect(open(h)).toEqual(['art']);
    h.act(() => h.overlays.setStageMenuOpen(false));
    expect(escapeOn().defaultPrevented).toBe(true);
    expect(open(h)).toEqual([]);
  });

  it('works from inside an overlay’s own content, whose focus is where the user is', () => {
    const h = mountOverlays(state());
    h.act(() => h.overlays.openTicketData());
    const closeBtn = must('#ticketDataClose');
    closeBtn.focus();
    expect(escapeOn(closeBtn).defaultPrevented).toBe(true);
    expect(open(h)).toEqual([]);
    h.act(() => h.overlays.openIndex());
    expect(escapeOn(must('#artView')).defaultPrevented).toBe(true);
  });

  it('ignores an Escape that starts inside another React region: that region’s own handler owns it', () => {
    const h = mountOverlays(state());
    h.act(() => h.overlays.openTicketData());
    for (const selector of ['.dhead', '#rail', '#inside', '#blocked', '.svpanel', '#artPanel', '[data-react-owned]']) {
      const region = document.createElement('div');
      if (selector.startsWith('.')) region.className = selector.slice(1);
      else if (selector.startsWith('#')) region.id = selector.slice(1);
      else region.setAttribute('data-react-owned', 'true');
      const inner = document.createElement('input');
      region.append(inner);
      document.body.append(region);
      expect(escapeOn(inner).defaultPrevented, selector).toBe(false);
      region.remove();
    }
    expect(open(h)).toEqual(['drawer']);
  });

  it('does not claim an Escape it has nothing to close for, nor other keys', () => {
    const h = mountOverlays(state());
    h.act(() => h.overlays.openIndex());
    expect(press('Enter').defaultPrevented).toBe(false);
    expect(open(h)).toEqual(['art']);
  });

  it('a handler that stops the event first (the logs search field clearing itself) keeps the chain from seeing it', () => {
    const h = mountOverlays(state());
    openAll(h);
    h.act(() => {
      h.overlays.closeTicketData();
      h.overlays.closeConsole();
    });
    const search = document.createElement('input');
    must('#logsView').append(search);
    search.addEventListener('keydown', (e) => e.stopPropagation());
    escapeOn(search);
    expect(open(h)).toEqual(['logs']);
  });
});
