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
import { act, useEffect } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { buildSettingsState } from '../../state.js';
import { SETTINGS_SECTIONS } from '../../sections.js';
import { AnnouncerProvider, LiveRegion } from '../primitives/LiveRegion.js';
import { SettingsAppProvider, useSettingsApp } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_MANIFEST, FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { AppShell } from './AppShell.js';

afterEach(cleanup);

/**
 * A minimal General editor: the shell tests need a control that can make the
 * tab dirty without mounting a ported section (whose own suite owns the form).
 */
function HostEditor() {
  const app = useSettingsApp();
  return (
    <input
      name="host"
      value={app.state.draft.host ?? ''}
      onChange={(event) => app.edit((draft) => ({ ...draft, host: event.target.value }))}
    />
  );
}

function mount(): { bridge: TestBridge } {
  const bridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="general">
        <AppShell>
          <div data-testid="tab-content">
            <HostEditor />
            <QualityEditor />
            <AgentsEditor />
            <InstantApplyToggle />
          </div>
        </AppShell>
      </SettingsAppProvider>
      <LiveRegion />
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state: FIXTURE_STATE_PUSH }));
  return { bridge };
}

/** Makes the Agents section dirty without leaving General. */
function AgentsEditor() {
  const app = useSettingsApp();
  return (
    <button onClick={() => app.edit((draft) => ({ ...draft, agentProvider: 'codex' }))}>
      edit agents
    </button>
  );
}

/** Stands in for AgentsSection's Accounts sub-tab turning instant-apply on. */
function InstantApplyToggle() {
  const app = useSettingsApp();
  return <button onClick={() => app.setInstantApply(true)}>instant apply</button>;
}

/** Parks an invalid Quality edit (two local field errors) without leaving General. */
function QualityEditor() {
  const app = useSettingsApp();
  return (
    <button
      onClick={() =>
        app.edit((draft) => ({
          ...draft,
          review: {
            ...(draft.review ?? {}),
            stallDetection: { enabled: true, sameFileRounds: 0, repeatedFindingRounds: 0 },
          } as NonNullable<Manifest['review']>,
        }))
      }
    >
      break quality
    </button>
  );
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

  it('groups the sidebar nav into Setup / Workflow / Integrations with captions', () => {
    mount();
    const captions = [...document.querySelectorAll('.nav-caption')].map(
      (n) => n.textContent?.trim() ?? '',
    );
    expect(captions).toEqual(['Setup', 'Workflow', 'Integrations']);
    // The pinned buttons survive inside their groups, in the vanilla order.
    expect(navSections()).toEqual([
      'general',
      'git',
      'services',
      'approaches',
      'agents',
      'quality',
      'autopilot',
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

  it('puts the project button first in the top bar and marks the nav region', () => {
    mount();
    const topbar = document.querySelector('.topbar')!;
    expect(topbar.firstElementChild?.id).toBe('mobileProjectBtn');
    expect(document.querySelector('nav.sidebar')?.getAttribute('data-region')).toBe('nav');
  });

  it('keeps the project popover outside the sidebar foot so the narrow button can open it', () => {
    mount();
    fireEvent.click(document.getElementById('mobileProjectBtn')!);
    const pop = document.getElementById('projectInfoPop')!;
    expect(pop.classList.contains('open')).toBe(true);
    expect(pop.closest('.sidebar-foot')).toBeNull();
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

describe('AppShell — an invalid file blocks Save in the save bar', () => {
  it('names the faulted tab when the file is invalid and not edited (SET-5)', () => {
    const { bridge } = mount();
    act(() => bridge.push({ type: 'validation', ok: false, error: 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1' }));
    const bar = document.getElementById('saveState');
    expect(bar?.textContent).toBe('Fix the error on Autopilot to save');
    expect(bar?.classList.contains('is-error')).toBe(true);
    expect((document.getElementById('saveBtn') as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
  });

  it('offers a link to the faulted tab when it is not the one on screen (SET-5)', () => {
    const { bridge } = mount();
    act(() => bridge.push({ type: 'validation', ok: false, error: 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1' }));
    const banner = document.querySelector('.err-banner');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.querySelector('.k-btn--link')?.textContent).toBe('Go to Autopilot');
    expect(banner?.querySelector('.icon-island')).not.toBeNull();
    fireEvent.click(banner!.querySelector('.k-btn--link')!);
    expect(activeSection()).toBe('autopilot');
  });

  it('shows the count and the tab for local field errors (SET-4/SET-12)', () => {
    const { bridge } = mount();
    act(() =>
      bridge.push({
        type: 'state',
        state: {
          ...FIXTURE_STATE_PUSH,
          // two fields the Quality tab knows are wrong before the host sees them
          manifest: {
            ...FIXTURE_MANIFEST,
            review: {
              stallDetection: { enabled: true, sameFileRounds: 0, repeatedFindingRounds: 0 },
            } as unknown as NonNullable<Manifest['review']>,
          },
        },
      }),
    );
    const bar = document.getElementById('saveState');
    expect(bar?.textContent).toBe('Fix 2 fields on Quality to save');
    expect(bar?.classList.contains('is-error')).toBe(true);
    expect((document.getElementById('saveBtn') as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
  });

  it('does not block the shown tab on a parked edit from another tab (@arch:SAVE)', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByText('break quality'));
    act(() => bridge.push({ type: 'navigate', hash: '#agents' }));
    // The parked Quality edit is not the Agents candidate: the bar does not
    // claim Quality's errors block this tab, and the tab's own Save is gated
    // only by the Agents state (nothing to save there). The nav still shows the
    // parked tab as having unsaved changes.
    expect(document.getElementById('saveState')?.textContent).toBe('All changes saved');
    expect((document.getElementById('saveBtn') as HTMLButtonElement | null)?.disabled).toBe(true);
    const qualityNav = document.querySelector('.nav-btn[data-section="quality"]');
    expect(qualityNav?.className).toContain('has-changes');
    expect(qualityNav?.className).not.toContain('has-error');
  });

  it('does not present a transient host error as a blocking field fault', () => {
    const { bridge } = mount();
    act(() => bridge.push({ type: 'error', message: 'Token & usage panel unavailable' }));
    const bar = document.getElementById('saveState');
    // The save bar is about saving: an action failure is not a field fault.
    expect(bar?.textContent).toBe('All changes saved');
    expect(bar?.classList.contains('is-error')).toBe(false);
    // It still reports the failure in the banner, and the next authoritative
    // state push clears it instead of leaving it stuck across tabs.
    expect(document.querySelector('.err-banner')?.textContent).toContain('Token & usage panel unavailable');
    act(() => bridge.push({ type: 'state', state: FIXTURE_STATE_PUSH }));
    expect(document.querySelector('.err-banner')).toBeNull();
    expect(bar?.textContent).toBe('All changes saved');
  });

  it('never borrows a local count for a host fault on another tab', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByText('break quality'));
    act(() =>
      bridge.push({
        type: 'validation',
        ok: false,
        error: 'Invalid karst.yml: repositories[1].path must be a string',
      }),
    );
    // The sentence names the host fault's tab; Quality's two local errors must
    // not become "Fix 2 fields on Repositories".
    expect(document.getElementById('saveState')?.textContent).toBe('Fix the error on Repositories to save');
  });
});

describe('AppShell — the instant-apply Accounts tab', () => {
  /** Dirty the Agents section, show it, then stand in for the Accounts sub-tab. */
  const openInstantApply = (bridge: TestBridge): void => {
    fireEvent.click(screen.getByText('edit agents'));
    act(() => bridge.push({ type: 'navigate', hash: '#agents' }));
    act(() => screen.getByText('instant apply').click());
  };

  it('hides Save/Discard without hiding the fact that another Agents tab is dirty', () => {
    const { bridge } = mount();
    openInstantApply(bridge);
    expect(document.getElementById('saveBtn')).toBeNull();
    expect(document.getElementById('discardBtn')).toBeNull();
    expect(document.getElementById('saveState')?.textContent).toBe('Unsaved changes on another Agents tab');
  });

  it('Ctrl+S on the instant-apply tab does not save the hidden Agents edits', () => {
    const { bridge } = mount();
    openInstantApply(bridge);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(bridge.all('save')).toHaveLength(0);
  });

  it('entering the instant-apply tab ends a pending Discard/Undo', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByText('edit agents'));
    act(() => bridge.push({ type: 'navigate', hash: '#agents' }));
    fireEvent.click(document.getElementById('discardBtn')!);
    expect(document.getElementById('savedMsg')?.className).not.toContain('hidden');
    act(() => screen.getByText('instant apply').click());
    // Undo's controls are hidden here; the window must not outlive them.
    expect(document.getElementById('savedMsg')?.className).toContain('hidden');
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

  it('does not depend on the title attribute for the nav state (SET-13)', () => {
    const { bridge } = mount();
    act(() => bridge.push({ type: 'validation', ok: false, error: 'Invalid karst.yml: host must be a non-empty string' }));
    const general = document.querySelector('.nav-btn[data-section="general"]')!;
    expect(general.querySelector('.sr-only')?.textContent).toBe(', has an error');
    // The dot itself is decorative; its meaning is in the accessible name.
    expect(document.getElementById('dirtyDot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('labels an unsaved tab in its accessible name', () => {
    const { bridge } = mount();
    act(() => bridge.push({ type: 'validation', ok: true, error: null }));
    const input = document.querySelector('input[name="host"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.0.0.0' } });
    const general = document.querySelector('.nav-btn[data-section="general"]')!;
    expect(general.querySelector('.sr-only')?.textContent).toBe(', unsaved changes');
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

/** Reports "this page applies at once" the way the Accounts tab does. */
function InstantApplyOnMount() {
  const app = useSettingsApp();
  useEffect(() => {
    app.setInstantApply(true);
    // Mount once: the shell resets the flag on a section switch, and a probe
    // that re-applied it on every render would hide that reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe('AppShell — the footer icon buttons and unresolved copy (SET-14)', () => {
  it('uses Tabler glyphs for the manifest and the overflow, not letters', () => {
    mount();
    // TablerIcon is an icon island; without the DS runtime it is an empty span,
    // but it must be the island, never the literal Y / ⋮ text.
    expect(document.querySelector('.manifest-icon')?.textContent).toBe('');
    expect(document.querySelector('.manifest-icon .icon-island')).not.toBeNull();
    expect(document.querySelector('.project-more')?.textContent).toBe('');
    expect(document.querySelector('.project-more .icon-island')).not.toBeNull();
    expect(document.querySelector('.sidebar-project-label')).toBeNull();
  });

  it('says Not set where the project facts are unresolved', () => {
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
          [],
          false,
          ['claude'],
          [],
          {},
          undefined,
          '',
          { value: '', derived: false },
          '',
        ),
      }),
    );
    expect(document.getElementById('footProjectId')?.textContent).toBe('Not set');
    fireEvent.click(document.getElementById('projectInfoBtn')!);
    expect(document.getElementById('popProjectId')?.textContent).toBe('Not set');
    expect(document.getElementById('popManifestPath')?.textContent).toBe('Not set');
  });
});

describe('AppShell — compact save state and the loading placeholder (SET-3, SET-7)', () => {
  it('keeps the full sentence in the DOM and a compact form in data-compact', () => {
    mount();
    const bar = document.getElementById('saveState')!;
    expect(bar.textContent).toBe('All changes saved');
    expect(bar.getAttribute('data-compact')).toBe('Saved');
    expect(bar.querySelector('.save-state-full')?.textContent).toBe('All changes saved');
  });

  it('renders the loading placeholder in the content region before hydration', () => {
    const bridge = createTestBridge();
    const { container } = render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="general">
          <AppShell>
            <div data-testid="tab-content" />
          </AppShell>
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    const content = container.querySelector('.content')!;
    expect(content.querySelector('.k-empty')?.getAttribute('role')).toBe('status');
    expect(content.querySelector('.k-empty-title')?.textContent).toBe('Loading settings…');
    expect(content.querySelector('[data-testid="tab-content"]')).toBeNull();
    // The nav and topbar keep their geometry.
    expect(document.querySelector('nav.sidebar')).not.toBeNull();
    expect(document.querySelector('.topbar')).not.toBeNull();
  });
});

describe('AppShell — Save names its tab (SET-2) and Accounts applies at once (Q4-SAVE)', () => {
  it('renders Save with a hideable section name and an always-complete aria-label', () => {
    mount();
    const save = document.getElementById('saveBtn') as HTMLButtonElement;
    expect(save.textContent).toBe('Save General');
    expect(save.querySelector('.save-section-name')?.textContent).toBe(' General');
    expect(save.getAttribute('aria-label')).toBe('Save General');
  });

  it('hides Save and Discard on Agents › Accounts and explains the instant apply', () => {
    const bridge = createTestBridge();
    render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="agents">
          <AppShell>
            <div />
          </AppShell>
          <InstantApplyOnMount />
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    act(() => bridge.push({ type: 'state', state: FIXTURE_STATE_PUSH }));
    expect(document.getElementById('saveBtn')).toBeNull();
    expect(document.getElementById('discardBtn')).toBeNull();
    expect(document.querySelector('.instant-apply-note')?.textContent).toBe(
      'Changes here apply at once.',
    );
    // Leaving the tab resets it: Save and Discard come back on every other tab.
    fireEvent.click(document.querySelector('.nav-btn[data-section="general"]')!);
    expect(document.getElementById('saveBtn')).not.toBeNull();
    expect(document.getElementById('discardBtn')).not.toBeNull();
  });
});

describe('AppShell — Discard offers a 5 s Undo (Q11 / SET-15)', () => {
  function dirtyGeneral(bridge: TestBridge): void {
    act(() => bridge.push({ type: 'validation', ok: true, error: null }));
    fireEvent.change(document.querySelector('input[name="host"]') as HTMLInputElement, {
      target: { value: '0.0.0.0' },
    });
  }

  it('discards at once, shows Changes discarded + Undo and moves focus to Undo', () => {
    const { bridge } = mount();
    dirtyGeneral(bridge);
    expect((document.getElementById('saveBtn') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(document.getElementById('discardBtn')!);
    // The edit is gone (the action is not a dialog).
    expect((document.querySelector('input[name="host"]') as HTMLInputElement).value).toBe(
      FIXTURE_MANIFEST.host,
    );
    const msg = document.getElementById('savedMsg')!;
    expect(msg.classList.contains('hidden')).toBe(false);
    expect(msg.textContent).toContain('Changes discarded');
    const undo = msg.querySelector('button') as HTMLButtonElement;
    expect(undo.textContent).toBe('Undo');
    expect(document.activeElement).toBe(undo);
  });

  it('restores the draft and returns focus to Discard', () => {
    const { bridge } = mount();
    dirtyGeneral(bridge);
    fireEvent.click(document.getElementById('discardBtn')!);
    const undo = document.querySelector('#savedMsg button') as HTMLButtonElement;
    fireEvent.click(undo);
    expect((document.querySelector('input[name="host"]') as HTMLInputElement).value).toBe('0.0.0.0');
    expect(document.getElementById('savedMsg')?.classList.contains('hidden')).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('discardBtn'));
  });

  it('a new edit retires the Undo', () => {
    const { bridge } = mount();
    dirtyGeneral(bridge);
    fireEvent.click(document.getElementById('discardBtn')!);
    fireEvent.change(document.querySelector('input[name="host"]') as HTMLInputElement, {
      target: { value: '127.0.0.2' },
    });
    expect(document.getElementById('savedMsg')?.classList.contains('hidden')).toBe(true);
  });
});
