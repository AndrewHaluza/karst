/**
 * COMPONENT-mode tests for the pending-outputs panel on an approach card.
 * The load-bearing claim: NOTHING is posted until the user acts, and only the
 * accepted (possibly edited) rows travel to the host.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { ApproachesSection } from './ApproachesSection.js';

afterEach(cleanup);

const MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  approaches: [{ id: 'gsd', label: 'GSD' } as unknown as ApproachDef],
};

function mount(pending: Record<string, { glob: string; kind: 'plan' | 'spec' }[]>): TestBridge {
  const bridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="approaches">
        <ApproachesSection />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  const state = buildSettingsState(
    MANIFEST, null, ['gsd'], true, ['claude'], [], {}, undefined,
    '/repo/karst.yml', undefined, undefined, [], undefined, pending,
  );
  act(() => bridge.push({ type: 'state', state }));
  return bridge;
}

const PENDING = {
  gsd: [
    { glob: '.planning/research/**', kind: 'plan' as const },
    { glob: 'docs/extra/**', kind: 'spec' as const },
  ],
};

describe('PendingOutputs panel', () => {
  it('renders nothing for an approach with no pending suggestions', () => {
    mount({});
    expect(document.querySelector('[data-pending-outputs]')).toBeNull();
  });

  it('shows the suggestions and the built-in defaults as pre-accepted, posting nothing', () => {
    const bridge = mount(PENDING);
    const panel = document.querySelector('[data-pending-outputs="gsd"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('.planning/**'); // gsd default, pre-accepted
    expect(panel?.textContent).toContain('Built-in · accepted');
    expect(bridge.all('resolve-pending-outputs')).toEqual([]);
    expect(bridge.all('save')).toEqual([]);
  });

  it('Accept sends every row by default', () => {
    const bridge = mount(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Accept 2 selected' }));
    expect(bridge.last('resolve-pending-outputs')).toMatchObject({
      type: 'resolve-pending-outputs',
      id: 'gsd',
      accepted: PENDING.gsd,
    });
  });

  it('a rejected row and an edited row are reflected in what is sent', () => {
    const bridge = mount(PENDING);
    fireEvent.click(document.querySelector('[name="pending-accept-gsd-0"]') as HTMLElement);
    fireEvent.change(document.querySelector('[name="pending-glob-gsd-1"]') as HTMLElement, {
      target: { value: 'docs/mine/**' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept 1 selected' }));
    expect(bridge.last('resolve-pending-outputs')).toMatchObject({
      accepted: [{ glob: 'docs/mine/**', kind: 'spec' }],
    });
  });

  it('Reject all sends an empty accepted list', () => {
    const bridge = mount(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    expect(bridge.last('resolve-pending-outputs')).toMatchObject({ id: 'gsd', accepted: [] });
  });
});
