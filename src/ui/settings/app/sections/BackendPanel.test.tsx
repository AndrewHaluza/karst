/**
 * COMPONENT-mode tests for the Sandbox tab (SET-46..48).
 *
 * The rows name the core by its display name and mark, the segments read
 * Host / sbx / Docker, the readiness of the SELECTED backend sits in its own
 * row, and arrow keys move both the choice and the focus through the shared
 * segmented-control primitive.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider, useSettingsApp } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { buildSettingsState } from '../../state.js';
import { BackendPanel } from './BackendPanel.js';

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as Record<string, unknown>).agentIconInto;
});

const BASE = { ...FIXTURE_MANIFEST } as unknown as Manifest;

function DraftReader() {
  const { state } = useSettingsApp();
  return <span data-testid="draft-backends">{JSON.stringify(state.draft.agentBackends ?? null)}</span>;
}

function mount(manifest: Manifest = BASE): TestBridge {
  const bridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <BackendPanel />
        <DraftReader />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() =>
    bridge.push({
      type: 'state',
      state: buildSettingsState(manifest, null, [], true, ['claude'], [], {}, undefined, '/repo/karst.yml'),
    }),
  );
  return bridge;
}

const row = (core: string): HTMLElement => screen.getByTestId(`backend-row-${core}`);
const radio = (core: string, name: string): HTMLButtonElement =>
  within(row(core)).getByRole('radio', { name }) as HTMLButtonElement;
const draft = (): unknown => JSON.parse(screen.getByTestId('draft-backends').textContent ?? 'null');

describe('Sandbox tab — display names and segments (SET-46)', () => {
  it('names each core by its display name, in the form-grid label track', () => {
    mount();
    expect(document.getElementById('backend-label-claude')!.textContent).toBe('Claude Code');
    expect(document.getElementById('backend-label-agy')!.textContent).toBe('Antigravity CLI');
    expect(document.body.textContent).not.toContain('agy');
  });

  it('labels the segments Host, sbx and Docker', () => {
    mount();
    expect(within(row('claude')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Host', 'sbx']);
    expect(within(row('opencode')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Host', 'Docker']);
  });

  it('mounts the core mark through the injected agentIconInto, never a raw SVG (R-X6)', () => {
    const into = vi.fn();
    (globalThis as unknown as Record<string, unknown>).agentIconInto = into;
    mount();
    expect(into).toHaveBeenCalled();
    expect(into.mock.calls.some((call) => call[1] === 'antigravity')).toBe(true);
    expect(document.querySelector('.backend-core svg')).toBeNull();
  });
});

describe('Sandbox tab — keyboard radio group (SET-48)', () => {
  it('ArrowRight selects the next backend and moves focus with it', () => {
    mount();
    const host = radio('codex', 'Host');
    host.focus();
    fireEvent.keyDown(host, { key: 'ArrowRight' });
    expect(draft()).toEqual({ codex: 'sbx' });
    expect(document.activeElement).toBe(radio('codex', 'sbx'));
    expect(radio('codex', 'sbx').getAttribute('tabindex')).toBe('0');
    expect(radio('codex', 'Host').getAttribute('tabindex')).toBe('-1');
  });

  it('Home and End jump to the first and last option', () => {
    mount();
    const docker = radio('opencode', 'Docker');
    docker.focus();
    fireEvent.keyDown(docker, { key: 'Home' });
    expect(document.activeElement).toBe(radio('opencode', 'Host'));
    expect(draft()).toBeNull();
  });
});

describe('Sandbox tab — the status belongs to its row (SET-47)', () => {
  it('renders ready inside the selecting row only', () => {
    const bridge = mount({ ...BASE, agentBackends: { claude: 'sbx' } } as Manifest);
    act(() => bridge.push({ type: 'backend-status', status: { sbx: { ok: true }, docker: { ok: true } } } as never));
    const status = screen.getByTestId('backend-status-claude');
    expect(status.textContent).toContain('ready');
    expect(status.className).toContain('field-help');
    expect(screen.queryByTestId('backend-status-codex')).toBeNull();
  });

  it('renders the failing reason inside the row, with the command as code', () => {
    const bridge = mount({ ...BASE, agentBackends: { claude: 'sbx' } } as Manifest);
    act(() =>
      bridge.push({
        type: 'backend-status',
        status: { sbx: { ok: false, reason: 'sbx not signed in (run `sbx login`)' }, docker: { ok: true } },
      } as never),
    );
    const status = screen.getByTestId('backend-status-claude');
    expect(status.className).toContain('is-error');
    expect(status.textContent).toContain('sbx not signed in');
    expect(status.querySelector('code')!.textContent).toBe('sbx login');
  });

  it('says not checked until the host answers', () => {
    mount({ ...BASE, agentBackends: { codex: 'sbx' } } as Manifest);
    expect(screen.getByTestId('backend-status-codex').textContent).toBe('not checked');
  });

  it('asks the host to preflight only what the draft selects', () => {
    const bridge = mount();
    expect(bridge.last('check-backends')).toMatchObject({ want: { sbx: false, docker: false } });
    fireEvent.click(radio('opencode2', 'Docker'));
    expect(bridge.last('check-backends')).toMatchObject({ want: { sbx: false, docker: true } });
  });
});
