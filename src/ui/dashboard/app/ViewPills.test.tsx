// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DashboardState } from '../state.js';
import { mountOverlays, must, press } from './fixtures/overlaysKit.js';
import { stateWithArtifacts } from './fixtures/artifactFixtures.js';

const proc = (id: string, label: string, status = 'pass') => ({ id, label, status, console: true });
const withConsoles = (n: number): DashboardState => {
  const base = stateWithArtifacts({ servers: [] });
  const processes = [proc('a', 'A'), proc('b', 'B')].slice(0, n);
  return { ...base, insideViews: { uat: { stageKey: 'uat', title: 'UAT', processes } } } as unknown as DashboardState;
};
const pills = (): string[] => Array.from(document.querySelectorAll('.vp-pill')).map((b) => (b as HTMLElement).dataset.view!);

describe('ViewPills', () => {
  it('renders nothing on the dashboard', () => {
    mountOverlays(withConsoles(2));
    expect(document.querySelector('.vp-pill')).toBeNull();
    expect(must('#viewsRoot').classList.contains('hidden')).toBe(true);
  });

  it('appears on a drill-down surface with aria-current on the active pill, and hides pills with no target', () => {
    const h = mountOverlays(withConsoles(2));
    h.act(() => h.overlays.openIndex());
    expect(must('#viewsRoot').classList.contains('hidden')).toBe(false);
    expect(pills()).toEqual(['dashboard', 'artifacts', 'console']);
    expect(must('.vp-pill[aria-current="page"]').dataset.view).toBe('artifacts');
  });

  it('Console opens its only stream directly', () => {
    const h = mountOverlays(withConsoles(1));
    h.act(() => h.overlays.openIndex());
    fireEvent.click(must('[data-view="console"]'));
    expect(h.overlays.getSnapshot().console).toEqual({ stage: 'uat', processId: 'a' });
  });

  it('Console with several streams opens a menu; Enter picks, Escape closes it and returns focus to the pill', () => {
    const h = mountOverlays(withConsoles(2));
    h.act(() => h.overlays.openIndex());
    const pill = must('[data-view="console"]');
    fireEvent.click(pill);
    expect(h.overlays.getSnapshot().console).toBeNull();
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    press('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(pill);
    expect(h.overlays.getSnapshot().art).toBe('index');
    fireEvent.click(pill);
    fireEvent.click(document.querySelectorAll('[role="menuitem"]')[1]!);
    expect(h.overlays.getSnapshot().console).toEqual({ stage: 'uat', processId: 'b' });
  });

  it('the Dashboard pill goes home and lands on the history', () => {
    const h = mountOverlays(withConsoles(1));
    h.act(() => h.overlays.openIndex());
    fireEvent.click(must('[data-view="dashboard"]'));
    expect(h.overlays.getSnapshot().art).toBeNull();
    expect(h.overlays.getSnapshot().history).toHaveLength(2);
  });
});
