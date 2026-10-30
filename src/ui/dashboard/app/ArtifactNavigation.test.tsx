// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { all, bodyHas, isHidden, mountOverlays, must, text, type OverlayHarness } from './fixtures/overlaysKit.js';
import { SHA1, SHA2, stateWithArtifacts, storedWithSpec } from './fixtures/artifactFixtures.js';

const openIndex = (h: OverlayHarness): void => h.act(() => h.overlays.openIndex());
const openDetail = (h: OverlayHarness, id: string): void => h.act(() => h.overlays.openArtifact(id));

describe('ArtifactView — captured files in the one index', () => {
  const withStored = (v: unknown = storedWithSpec): DashboardState => stateWithArtifacts({ storedArtifacts: v });

  it('lists an unclaimed file under its stage group, after the semantic rows, and folds the claimed one into its detail', () => {
    const h = mountOverlays(withStored());
    openIndex(h);
    expect(all('.artgroup-title').map((n) => n.textContent)).toEqual(['Implement', 'UAT', 'Review', 'Ship', 'Unassigned']);
    expect(all('.sa-path').map((n) => n.textContent)).toEqual(['app / docs/spec.md']);
    expect(text('.dh-current')).toMatch(/^Artifacts · \d+$/);
    expect(all('.sa-bar button').map((b) => b.textContent)).toEqual(['Reveal folder', 'Purge files…']);
    openDetail(h, 'plan');
    expect(all('[aria-label="Captured files"] .sa-path').map((n) => n.textContent)).toEqual(['app / plans/a.md']);
    expect(all('[data-act="stored-artifact-diff"]')).toHaveLength(1); // the oldest revision has no previous one
    expect(all('.sa-rev')).toHaveLength(2);
  });

  it('lays the detail out as a main column and a side panel: About and Files (with captured files) beside the evidence', () => {
    const h = mountOverlays(withStored());
    openDetail(h, 'plan');
    const side = must('.artdetail > .artdetail-grid > aside.artside');
    expect(side.querySelector('[aria-label="Details"]')).not.toBeNull();
    expect(side.querySelector('[aria-label="Captured files"]')).not.toBeNull();
    const main = must('.artdetail > .artdetail-grid > .artmain');
    expect(main.querySelector('[aria-label="Details"]')).toBeNull();
    expect(main.querySelector('.artmetrics, [aria-label="Tasks"]')).not.toBeNull();
  });

  it('posts store paths and revision shas only, each with a request id', () => {
    const h = mountOverlays(withStored());
    openDetail(h, 'plan');
    fireEvent.click(must('.sa-main [data-act="stored-artifact-open"]'));
    fireEvent.click(must('[data-act="stored-artifact-live"]'));
    fireEvent.click(must('[data-act="stored-artifact-diff"]'));
    expect(h.send.storedArtifactOpen.mock.calls).toEqual([['app/plans/a.md', SHA2, 'req-1']]);
    expect(h.send.storedArtifactLive.mock.calls).toEqual([['app/plans/a.md', 'req-2']]);
    expect(h.send.storedArtifactDiff.mock.calls).toEqual([['app/plans/a.md', SHA1, SHA2, 'req-3']]);
  });

  it('Reveal folder and Purge files… post once each from the index header', () => {
    const h = mountOverlays(withStored());
    openIndex(h);
    fireEvent.click(must('[data-act="stored-artifact-reveal"]'));
    fireEvent.click(must('[data-act="stored-artifact-purge"]'));
    expect(h.send.storedArtifactReveal.mock.calls).toEqual([['req-1']]);
    expect(h.send.storedArtifactPurge.mock.calls).toEqual([['req-2']]);
  });

  it('opens a history revision, and Back returns to the previous view', () => {
    const h = mountOverlays(withStored());
    openIndex(h);
    openDetail(h, 'plan');
    fireEvent.click(all('.sa-rev [data-act="stored-artifact-open"]')[1]!);
    expect(h.send.storedArtifactOpen.mock.calls).toEqual([['app/plans/a.md', SHA1, 'req-1']]);
    fireEvent.click(must('[data-art="back"]'));
    expect(h.overlays.getSnapshot().art).toBe('index');
  });
});

const DASH = { console: null, logs: false, env: false, art: null };

describe('ArtifactView — scroll memory and persistence', () => {
  const setTop = (n: number): void => {
    document.documentElement.scrollTop = n;
  };
  const top = (): number => document.documentElement.scrollTop;

  it('remembers where each surface was read and puts it back on return', () => {
    const h = mountOverlays(stateWithArtifacts());
    setTop(500);
    openIndex(h);
    expect(top()).toBe(0); // the index has not been read yet
    setTop(80);
    openDetail(h, 'plan');
    setTop(900);
    h.act(() => h.overlays.back());
    expect(top()).toBe(80);
    h.act(() => h.overlays.back());
    expect(top()).toBe(500);
    openIndex(h);
    openDetail(h, 'plan');
    expect(top()).toBe(900);
  });

  it('announces the view and the scrolls after each navigation', () => {
    const h = mountOverlays(stateWithArtifacts());
    setTop(500);
    openIndex(h);
    expect(h.persisted.at(-1)).toEqual({ artView: 'index', artScrolls: { ticket: 500, index: 0, detail: {} }, history: [DASH] });
    fireEvent.click(must('[data-art-open="plan"]'));
    expect(h.persisted.at(-1)?.artView).toEqual({ id: 'plan', from: 'index' });
    expect(h.persisted).toHaveLength(2);
  });

  it('restores the persisted view at the persisted scroll', () => {
    mountOverlays(stateWithArtifacts(), { persisted: { artView: { id: 'plan', from: 'index' }, artScrolls: { ticket: 0, index: 10, detail: { plan: 640 } } } });
    expect(isHidden('#artView')).toBe(false);
    expect(bodyHas('art-nav')).toBe(true);
    expect(text('.art-title')).toBe('Plan');
    expect(must('[data-art="back"]').getAttribute('aria-label')).toBe('Back to Dashboard'); // no history persisted: Back answers the dashboard
    expect(top()).toBe(640);
  });

  it('restores the index, and ignores a persisted view it cannot read', () => {
    mountOverlays(stateWithArtifacts(), { persisted: { artView: 'index', artScrolls: { ticket: 0, index: 33, detail: {} } } });
    expect(all('.artrow')).toHaveLength(4);
    expect(top()).toBe(33);
  });

  it('shows the ticket when the persisted view is garbage', () => {
    const h = mountOverlays(stateWithArtifacts(), { persisted: { artView: 7, artScrolls: 'x' } });
    expect(h.overlays.getSnapshot().art).toBeNull();
    expect(isHidden('#artView')).toBe(true);
  });
});
