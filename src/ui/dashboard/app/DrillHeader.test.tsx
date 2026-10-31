// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mountOverlays, must, text, all } from './fixtures/overlaysKit.js';
import { stateWithArtifacts } from './fixtures/artifactFixtures.js';

describe('DrillHeader', () => {
  it('Back names the previous view and pops the history; the last crumb is the current page', () => {
    const h = mountOverlays(stateWithArtifacts());
    h.act(() => h.overlays.openIndex());
    h.act(() => h.overlays.openArtifact('plan'));
    expect(must('[data-art="back"]').getAttribute('aria-label')).toBe('Back to Artifacts');
    expect(must('.dh-current [aria-current="page"]').textContent).toBe('Plan');
    fireEvent.click(must('[data-art="back"]'));
    expect(h.overlays.getSnapshot().art).toBe('index');
    expect(must('[data-art="back"]').getAttribute('aria-label')).toBe('Back to Dashboard');
  });

  it('a middle crumb is a link that navigates there', () => {
    const h = mountOverlays(stateWithArtifacts());
    h.act(() => h.overlays.openArtifact('plan'));
    expect(text('.dh-mid')).toBe('Artifacts');
    fireEvent.click(must('.dh-mid .dh-link'));
    expect(h.overlays.getSnapshot().art).toBe('index');
    expect(all('.dh-link')).toHaveLength(0);
  });
});
