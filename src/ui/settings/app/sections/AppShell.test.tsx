/**
 * COMPONENT-mode tests for the shell chrome (NDL-126 §9.5, phase 4).
 *
 * The shell is the part of the settings document the tab ports did not own:
 * the sidebar brand mark, the nav's bijection with the section vocabulary,
 * the compact project-identity footer (handoff §5.2) with its details popover
 * and manifest open, and the topbar's save-state region and mobile project
 * entry. These replace the static/VM assertions the retired
 * `settings/webview.test.ts` made about that markup (`settings v7 shell`,
 * `settings v7 project footer rendering`, `project facts`,
 * `settings section navigation`), re-pointed at the React shell that renders
 * it now.
 *
 * The state-dependent half — dirty markers on nav, the leave gate, tab-scoped
 * Save — lives in the rendered-Settings suites; these tests cover the chrome's
 * structure, its host-pushed facts and the manifest button's pending lifecycle.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSettingsState } from '../../state.js';
import { SETTINGS_SECTIONS } from '../../sections.js';
import { AnnouncerProvider, LiveRegion } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_MANIFEST, FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { AppShell } from './AppShell.js';

afterEach(cleanup);

function mount(): { bridge: TestBridge } {
  const bridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="general">
        <AppShell>
          <div data-testid="tab-content" />
        </AppShell>
      </SettingsAppProvider>
      <LiveRegion />
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state: FIXTURE_STATE_PUSH }));
  return { bridge };
}

/** The nav's section ids, in document order. */
function navSections(): string[] {
  return [...document.querySelectorAll('.nav-btn[data-section]')].map(
    (btn) => btn.getAttribute('data-section') ?? '',
  );
}

function activeSection(): string | null {
  return document.querySelector('.nav-btn.active')?.getAttribute('data-section') ?? null;
}

describe('AppShell — the left nav is the whole section vocabulary', () => {
  it('every nav button targets a section that exists, and vice versa', () => {
    mount();
    const targets = navSections();
    // The omission that blanked Git in the vanilla view: Git must be on offer.
    expect(targets).toContain('git');
    expect([...targets].sort()).toEqual([...SETTINGS_SECTIONS].sort());
    expect(targets).toHaveLength(new Set(targets).size);
  });

  it('groups the sidebar nav into Project / Workflow / Integrations with captions', () => {
    mount();
    const captions = [...document.querySelectorAll('.nav-caption')].map(
      (n) => n.textContent?.trim() ?? '',
    );
    expect(captions).toEqual(['Project', 'Workflow', 'Integrations']);
    // The pinned buttons survive inside their groups, in the vanilla order.
    expect(navSections()).toEqual([
      'general',
      'git',
      'services',
      'approaches',
      'agents',
      'quality',
      'ticketing',
    ]);
    expect(document.querySelector('nav.sidebar')).not.toBeNull();
  });

  it('nav clicks route through the section switch and mark the shown tab active', () => {
    mount();
    expect(activeSection()).toBe('general');
    const git = document.querySelector('.nav-btn[data-section="git"]');
    expect(git).not.toBeNull();
    fireEvent.click(git!);
    expect(activeSection()).toBe('git');
    expect(document.querySelector('.topbar-section')?.textContent).toBe('› Git');
    // Exactly one tab is ever active — showing a section never blanks them all.
    expect(document.querySelectorAll('.nav-btn.active')).toHaveLength(1);
  });
});

describe('AppShell — the brand and project footer carry the approved #35 mark', () => {
  it('the sidebar brand mark is the approved #35 mark, not the old letter badge', () => {
    mount();
    const mark = document.querySelector('.brand .brandmark');
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute('viewBox')).toBe('0 0 215 215');
    // The mark's own geometry, not a letter box behind it.
    const paths = [...mark!.querySelectorAll('path, circle')];
    expect(paths.length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('.brand .brand-name')?.textContent).toBe('Karst settings');
    expect(document.querySelector('span.brandmark')).toBeNull();
  });

  it('the project-info footer and mobile entry carry the approved #35 mark, not the letter badge', () => {
    mount();
    const footIcon = document.querySelector('.project-icon');
    expect(footIcon).not.toBeNull();
    expect(footIcon!.getAttribute('viewBox')).toBe('0 0 215 215');
    // Each placement owns its page-scoped gradient ids, as the vanilla markup did.
    for (const prefix of ['foot', 'set', 'mob']) {
      expect(document.getElementById(`${prefix}Left`), `${prefix}Left gradient`).not.toBeNull();
      expect(document.getElementById(`${prefix}Core`), `${prefix}Core gradient`).not.toBeNull();
    }
    const mobile = document.getElementById('mobileProjectBtn');
    expect(mobile).not.toBeNull();
    expect(mobile!.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 215 215');
    expect(mobile!.getAttribute('aria-label')).toBe('Project information');
    expect(document.querySelector('span.project-icon')).toBeNull();
  });

  it('adds a compact project identity footer with manifest open and a details popover', () => {
    mount();
    for (const id of [
      'projectInfoBtn',
      'footProjectId',
      'footProjectVersion',
      'footOpenManifest',
      'projectInfoPop',
      'popManifestPath',
    ]) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
    // Closed by its own display:none rule, never the !important .hidden class.
    const pop = document.getElementById('projectInfoPop')!;
    expect(pop.classList.contains('open')).toBe(false);
    expect(pop.classList.contains('hidden')).toBe(false);
  });
});

describe('AppShell — the project-info popover dismisses like the vanilla one', () => {
  function pop(): HTMLElement {
    return document.getElementById('projectInfoPop')!;
  }

  it('toggles open from the footer button and reflects aria-expanded', () => {
    mount();
    const btn = document.getElementById('projectInfoBtn')!;
    fireEvent.click(btn);
    expect(pop().classList.contains('open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn);
    expect(pop().classList.contains('open')).toBe(false);
  });

  it('Escape closes it and returns focus to the footer button', () => {
    mount();
    const btn = document.getElementById('projectInfoBtn')!;
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(pop().classList.contains('open')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
  });

  it('a click outside closes it; a click inside does not', () => {
    mount();
    fireEvent.click(document.getElementById('projectInfoBtn')!);
    fireEvent.mouseDown(document.getElementById('popVersion')!);
    expect(pop().classList.contains('open')).toBe(true);
    fireEvent.mouseDown(document.querySelector('[data-testid="tab-content"]')!);
    expect(pop().classList.contains('open')).toBe(false);
  });

  it('the mobile entry opens it too', () => {
    mount();
    fireEvent.click(document.getElementById('mobileProjectBtn')!);
    expect(pop().classList.contains('open')).toBe(true);
  });
});

describe('AppShell — the footer renders the host-pushed facts (UI-R31)', () => {
  it('fills the footer and popover from the host-pushed facts', () => {
    mount();
    expect(document.getElementById('footProjectId')?.textContent).toBe('repo');
    expect(document.getElementById('footProjectVersion')?.textContent).toBe('v1.2.3');
    expect(document.getElementById('footManifestName')?.textContent).toBe('karst.yml');
    fireEvent.click(document.getElementById('projectInfoBtn')!);
    expect(document.getElementById('projectInfoPop')!.classList.contains('open')).toBe(true);
    expect(document.getElementById('projectInfoBtn')!.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('popProjectId')?.textContent).toBe('repo');
    expect(document.getElementById('popIdSource')?.textContent).toBe('Explicit (manifest id:)');
    expect(document.getElementById('popVersion')?.textContent).toBe('1.2.3');
    expect(document.getElementById('popManifestPath')?.textContent).toBe('/repo/karst.yml');
  });

  it('shows the derived id source when the manifest has no explicit id', () => {
    const bridge = createTestBridge();
    render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="general">
          <AppShell>
            <div />
          </AppShell>
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    act(() =>
      bridge.push({
        type: 'state',
        state: buildSettingsState(
          FIXTURE_MANIFEST,
          null,
          ['tdd'],
          true,
          ['claude'],
          [],
          {},
          undefined,
          '/repo/karst.yml',
          { value: 'path-derived-slug', derived: true },
          '1.2.3',
        ),
      }),
    );
    expect(document.getElementById('footProjectId')?.textContent).toBe('path-derived-slug');
    fireEvent.click(document.getElementById('projectInfoBtn')!);
    expect(document.getElementById('popIdSource')?.textContent).toBe(
      'Derived from workspace path',
    );
  });

  it('the Open manifest button posts through the pending action runtime (UI-R11)', () => {
    const { bridge } = mount();
    const button = document.getElementById('footOpenManifest') as HTMLButtonElement;
    fireEvent.click(button);
    const posts = bridge.all('open-manifest');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.requestId).toBeTruthy();
    // Pending is set synchronously on activation: a second click posts nothing.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(bridge.all('open-manifest')).toHaveLength(1);

    act(() =>
      bridge.push({
        type: 'action-result',
        requestId: posts[0]!.requestId!,
        ok: true,
      }),
    );
    expect(
      (document.getElementById('footOpenManifest') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(document.querySelector('.k-live-region')?.textContent).toBe('Manifest open succeeded.');
  });
});

describe('AppShell — the topbar keeps the vanilla entry points', () => {
  it('keeps the topbar save-state region, the dirty dot id and the mobile project entry', () => {
    mount();
    expect(document.getElementById('saveState')).not.toBeNull();
    expect(document.getElementById('saveState')?.textContent).toBe('All changes saved');
    const dot = document.getElementById('dirtyDot');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute('title')).toBe('Unsaved changes on this tab');
    expect(dot!.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('mobileProjectBtn')).not.toBeNull();

    // The mobile entry opens the same details popover as the sidebar footer.
    fireEvent.click(document.getElementById('mobileProjectBtn')!);
    expect(document.getElementById('projectInfoPop')!.classList.contains('open')).toBe(true);
  });

  it('switching tabs while unhydrated does not validate empty drafts', () => {
    const bridge = createTestBridge();
    render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="general">
          <AppShell>
            <div data-testid="tab-content" />
          </AppShell>
        </SettingsAppProvider>
        <LiveRegion />
      </AnnouncerProvider>,
    );
    // Click Git tab before any state push lands
    const gitBtn = document.querySelector('.nav-btn[data-section="git"]');
    expect(gitBtn).not.toBeNull();
    fireEvent.click(gitBtn!);
    expect(activeSection()).toBe('git');
    // Must NOT post validate with an empty draft (which would fail with "host must be a non-empty string")
    expect(bridge.all('validate')).toHaveLength(0);
  });
});
