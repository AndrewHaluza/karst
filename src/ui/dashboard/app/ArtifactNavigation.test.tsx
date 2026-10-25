// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { all, bodyHas, isHidden, mountOverlays, must, text, type OverlayHarness } from './fixtures/overlaysKit.js';
import { SHA1, SHA2, stateWithArtifacts, storedView } from './fixtures/artifactFixtures.js';

const openIndex = (h: OverlayHarness): void => h.act(() => h.overlays.openIndex());
const openDetail = (h: OverlayHarness, id: string): void => h.act(() => h.overlays.openArtifact(id));
const view = (): string => must('#artView').textContent ?? '';

describe('ArtifactView — the stored view', () => {
  const withStored = (v: unknown = storedView): DashboardState => stateWithArtifacts({ storedArtifacts: v });
  const openStored = (h: OverlayHarness): void => h.act(() => h.overlays.openStored());

  it('groups kind then approach and lists rows, history and skipped files', () => {
    const h = mountOverlays(withStored());
    openStored(h);
    expect(text('.artsub')).toBe('Artifacts · 1');
    expect(all('.artgroup-title').map((n) => n.textContent)).toEqual(['plan', 'Skipped files']);
    expect(text('.sa-path')).toBe('app / plans/a.md');
    expect(text('.sa-main .sa-meta').replace(/\s+/g, ' ')).toMatch(/^2 revisions · /);
    expect(view()).toContain('app/.env — secret-pattern');
    expect(all('[data-act="stored-artifact-diff"]')).toHaveLength(1); // the oldest revision has no previous one
    expect(all('.sa-rev')).toHaveLength(2);
    expect(must('.sa-hist summary').textContent).toBe('History');
    expect(all('.sa-bar button').map((b) => b.textContent)).toEqual(['Reveal folder', 'Purge artifacts']);
  });

  it('names the active outputs globs in the empty state, and shows Loading until the host answers', () => {
    const h = mountOverlays(withStored({ total: 0, groups: [], skips: [], globs: ['plans/**', 'docs/spec/*.md'] }));
    openStored(h);
    expect(must('.sa-empty').textContent).toBe('No artifacts captured yet. Watching: plans/**, docs/spec/*.md.');
    expect(all('.sa-empty code').map((c) => c.textContent)).toEqual(['plans/**', 'docs/spec/*.md']);
    h.emit({ type: 'state', state: withStored({ total: 0, groups: [], skips: [], globs: [] }) });
    expect(must('.sa-empty').textContent).toBe('No artifacts captured yet. No outputs globs are configured for the enabled approaches.');
  });

  it('says Loading while the store has not answered', () => {
    const h = mountOverlays(stateWithArtifacts());
    openStored(h);
    expect(text('.artsub')).toBe('Artifacts · 0');
    expect(must('.sa-empty').textContent).toBe('Loading…');
  });

  it('posts store paths and revision shas only, each with a request id', () => {
    const h = mountOverlays(withStored());
    openStored(h);
    fireEvent.click(must('.sa-main [data-act="stored-artifact-open"]'));
    fireEvent.click(must('[data-act="stored-artifact-live"]'));
    fireEvent.click(must('[data-act="stored-artifact-diff"]'));
    fireEvent.click(must('[data-act="stored-artifact-reveal"]'));
    fireEvent.click(must('[data-act="stored-artifact-purge"]'));
    expect(h.send.storedArtifactOpen.mock.calls).toEqual([['app/plans/a.md', SHA2, 'req-1']]);
    expect(h.send.storedArtifactLive.mock.calls).toEqual([['app/plans/a.md', 'req-2']]);
    expect(h.send.storedArtifactDiff.mock.calls).toEqual([['app/plans/a.md', SHA1, SHA2, 'req-3']]);
    expect(h.send.storedArtifactReveal.mock.calls).toEqual([['req-4']]);
    expect(h.send.storedArtifactPurge.mock.calls).toEqual([['req-5']]);
  });

  it('opens a history revision, and Back returns to the ticket', () => {
    const h = mountOverlays(withStored());
    openStored(h);
    fireEvent.click(all('.sa-rev [data-act="stored-artifact-open"]')[1]!);
    expect(h.send.storedArtifactOpen.mock.calls).toEqual([['app/plans/a.md', SHA1, 'req-1']]);
    fireEvent.click(must('[data-art="back"]'));
    expect(isHidden('#artView')).toBe(true);
  });
});

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
    expect(h.persisted.at(-1)).toEqual({ artView: 'index', artScrolls: { ticket: 500, index: 0, detail: {} } });
    fireEvent.click(must('[data-art-open="plan"]'));
    expect(h.persisted.at(-1)?.artView).toEqual({ id: 'plan', from: 'index' });
    expect(h.persisted).toHaveLength(2);
  });

  it('restores the persisted view at the persisted scroll', () => {
    mountOverlays(stateWithArtifacts(), { persisted: { artView: { id: 'plan', from: 'index' }, artScrolls: { ticket: 0, index: 10, detail: { plan: 640 } } } });
    expect(isHidden('#artView')).toBe(false);
    expect(bodyHas('art-nav')).toBe(true);
    expect(text('.art-title')).toBe('Plan');
    expect(must('[data-art="back"]').textContent).toBe('← Artifacts');
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
