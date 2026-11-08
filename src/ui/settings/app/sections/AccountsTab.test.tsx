/**
 * COMPONENT-mode tests for the Accounts tab (D505): the list, the add wizard,
 * the delete confirmation and the notes. The host is the test bridge.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountsCoreView, AccountsHostMessage } from '../../accountsMessages.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { AccountsTab } from './AccountsTab.js';

afterEach(cleanup);

const CORE = (core: AccountsCoreView['core'], extra: AccountsCoreView['rows'] = [], active = 'default'): AccountsCoreView => ({
  core,
  active,
  rows: [
    { name: 'default', label: 'Default (CLI home)', active: active === 'default', builtIn: true, status: 'signed-in' },
    ...extra,
  ],
});
const WORK = { name: 'work', label: 'work', active: false, builtIn: false, source: 'managed', dir: '/a/work', status: 'not-signed-in' } as const;
const FOLDER = { name: 'fold', label: 'fold', active: false, builtIn: false, source: 'folder', dir: '/h/f', status: 'unknown' } as const;

function mount(cores: AccountsCoreView[] = [CORE('claude', [WORK, FOLDER]), CORE('codex'), CORE('opencode')]) {
  const bridge: TestBridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <AccountsTab route={{ tab: 'accounts' }} navigate={() => {}} />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  const push = (m: AccountsHostMessage): void => { act(() => bridge.push(m)); };
  push({ type: 'accounts-state', cores });
  return { bridge, push };
}

const wizardOf = (): HTMLElement => document.querySelector('[data-region="accounts-add-wizard"]') as HTMLElement;

describe('Accounts tab', () => {
  it('asks the host for the accounts on mount', () => {
    const { bridge } = mount();
    expect(bridge.last('accounts-load')).toBeTruthy();
  });

  it('says accounts apply at once and are not part of Save', () => {
    mount();
    expect(screen.getByText(/apply at once/i)).toBeTruthy();
    expect(screen.getByText(/not part of Save/i)).toBeTruthy();
  });

  it('shows a row per core, default first and without a delete button', () => {
    mount();
    const rows = document.querySelectorAll('[data-region="accounts-core-row"]');
    expect(rows.length).toBe(3);
    const table = within(rows[0] as HTMLElement).getByRole('table');
    const body = within(table).getAllByRole('row').slice(1);
    expect(within(body[0]!).getByText('Default (CLI home)')).toBeTruthy();
    expect(within(body[0]!).queryByRole('button', { name: /delete/i })).toBeNull();
    expect(within(body[1]!).getByRole('button', { name: /delete work/i })).toBeTruthy();
    expect(within(body[2]!).getByText('unknown')).toBeTruthy();
  });

  it('shows the empty hint when only default exists', () => {
    mount([CORE('codex')]);
    expect(screen.getByText(/only the default account/i)).toBeTruthy();
  });

  it('sets the active account and notes that running sessions keep theirs', () => {
    const { bridge } = mount();
    fireEvent.change(screen.getAllByLabelText(/active account/i)[0]!, { target: { value: 'work' } });
    expect(bridge.last('accounts-set-active')).toMatchObject({ core: 'claude', name: 'work' });
    expect(screen.getByText(/running sessions keep their account/i)).toBeTruthy();
  });

  it('confirms a delete in the page, with a folder choice for a managed account', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByRole('button', { name: /delete work/i }));
    const box = document.querySelector('[data-region="accounts-delete-confirm"]') as HTMLElement;
    expect(within(box).getByLabelText(/also remove its folder/i)).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: /^delete$/i }));
    expect(bridge.last('accounts-delete')).toMatchObject({ core: 'claude', name: 'work', removeFolder: false });
  });

  it('never offers to remove the folder of a folder account', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /delete fold/i }));
    const box = document.querySelector('[data-region="accounts-delete-confirm"]') as HTMLElement;
    expect(within(box).queryByLabelText(/also remove its folder/i)).toBeNull();
    expect(within(box).getByText(/keeps your folder/i)).toBeTruthy();
  });

  it('shows the host reason when a delete is refused', () => {
    const { push } = mount();
    fireEvent.click(screen.getByRole('button', { name: /delete work/i }));
    push({ type: 'accounts-error', core: 'claude', op: 'accounts-delete', message: 'used by a live session. Stop the session first.' });
    expect(screen.getByRole('alert').textContent).toMatch(/live session/);
  });

  it('walks the managed add flow: source, copy, sign in', () => {
    const { bridge, push } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: /add account/i })[0]!);
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/account name/i), { target: { value: 'two' } });
    fireEvent.click(within(wizard).getByRole('button', { name: /^add$/i }));
    expect(bridge.last('accounts-add')).toMatchObject({ core: 'claude', name: 'two', spec: { source: 'managed' } });
    push({ type: 'accounts-added', core: 'claude', name: 'two', status: 'not-signed-in' });
    expect(bridge.last('accounts-seed-items')).toMatchObject({ core: 'claude', name: 'two' });
    push({ type: 'accounts-seed', core: 'claude', name: 'two', items: [{ id: 'settings', label: 'Settings', checked: true }, { id: 'skills', label: 'Skills', checked: false }] });
    const list = document.querySelector('[data-region="accounts-copy-checklist"]') as HTMLElement;
    expect((within(list).getByLabelText('Settings') as HTMLInputElement).checked).toBe(true);
    expect((within(list).getByLabelText('Skills') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(wizard).getByRole('button', { name: /copy selected/i }));
    expect(bridge.last('accounts-copy-seed')).toMatchObject({ items: ['settings'] });
    push({ type: 'accounts-copy-result', core: 'claude', name: 'two', copied: ['settings'], skipped: [] });
    const step = document.querySelector('[data-region="accounts-signin-step"]') as HTMLElement;
    fireEvent.click(within(step).getByRole('button', { name: /log in now/i }));
    expect(bridge.last('accounts-login')).toMatchObject({ core: 'claude', name: 'two' });
  });

  it('skips the copy and shows Signed in with no login button', () => {
    const { push } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: /add account/i })[0]!);
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/account name/i), { target: { value: 'two' } });
    fireEvent.click(within(wizard).getByRole('button', { name: /^add$/i }));
    push({ type: 'accounts-added', core: 'claude', name: 'two', status: 'signed-in' });
    push({ type: 'accounts-seed', core: 'claude', name: 'two', items: [{ id: 'settings', label: 'Settings', checked: true }] });
    fireEvent.click(within(wizard).getByRole('button', { name: /^skip$/i }));
    expect(within(wizard).getByText('Signed in')).toBeTruthy();
    expect(within(wizard).queryByRole('button', { name: /log in now/i })).toBeNull();
  });

  it('explains the copy step for opencode', () => {
    const { push } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: /add account/i })[2]!);
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/account name/i), { target: { value: 'oc' } });
    fireEvent.click(within(wizard).getByRole('button', { name: /^add$/i }));
    push({ type: 'accounts-added', core: 'opencode', name: 'oc', status: 'unknown' });
    push({ type: 'accounts-seed', core: 'opencode', name: 'oc', items: [] });
    expect(within(wizard).getByText(/config is already shared/i)).toBeTruthy();
  });

  it('sends pasted alias text with the alias name found in it', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: /add account/i })[0]!);
    fireEvent.change(within(wizardOf()).getByLabelText(/source/i), { target: { value: 'command' } });
    const imp = document.querySelector('[data-region="accounts-alias-import"]') as HTMLElement;
    const text = "alias cw='CLAUDE_CONFIG_DIR=$HOME/.cw claude'";
    fireEvent.change(within(imp).getByLabelText(/alias/i), { target: { value: text } });
    fireEvent.click(within(imp).getByRole('button', { name: /import alias/i }));
    expect(bridge.last('accounts-import-alias')).toMatchObject({ core: 'claude', alias: 'cw', text });
  });

  it('refuses pasted text with no alias name without asking the host', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: /add account/i })[0]!);
    fireEvent.change(within(wizardOf()).getByLabelText(/source/i), { target: { value: 'command' } });
    const imp = document.querySelector('[data-region="accounts-alias-import"]') as HTMLElement;
    fireEvent.change(within(imp).getByLabelText(/alias/i), { target: { value: 'some words here' } });
    fireEvent.click(within(imp).getByRole('button', { name: /import alias/i }));
    expect(bridge.last('accounts-import-alias')).toBeUndefined();
    expect(within(imp).getByText(/no alias name/i)).toBeTruthy();
  });

  it('does not reopen a closed delete confirmation when the same name is added again', () => {
    const { push } = mount();
    fireEvent.click(screen.getByRole('button', { name: /delete work/i }));
    expect(document.querySelector('[data-region="accounts-delete-confirm"]')).toBeTruthy();
    push({ type: 'accounts-state', cores: [CORE('claude', [FOLDER]), CORE('codex'), CORE('opencode')] });
    expect(document.querySelector('[data-region="accounts-delete-confirm"]')).toBeNull();
    push({ type: 'accounts-state', cores: [CORE('claude', [WORK, FOLDER]), CORE('codex'), CORE('opencode')] });
    expect(document.querySelector('[data-region="accounts-delete-confirm"]')).toBeNull();
  });

  it('imports an alias, shows env keys only, and shows a refusal reason', () => {
    const { bridge, push } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: /add account/i })[0]!);
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/source/i), { target: { value: 'command' } });
    const imp = document.querySelector('[data-region="accounts-alias-import"]') as HTMLElement;
    fireEvent.change(within(imp).getByLabelText(/alias/i), { target: { value: 'claude-work' } });
    fireEvent.click(within(imp).getByRole('button', { name: /import alias/i }));
    expect(bridge.last('accounts-import-alias')).toMatchObject({ core: 'claude', alias: 'claude-work' });
    push({ type: 'accounts-alias-result', core: 'claude', ok: false, reason: 'alias uses a pipe' });
    expect(within(imp).getByText(/alias uses a pipe/)).toBeTruthy();
    expect(within(wizard).getByLabelText(/^command$/i)).toBeTruthy();
    push({ type: 'accounts-alias-result', core: 'claude', ok: true, status: 'signed-in', account: { name: 'claude-work', source: 'folder', dir: '/h/.cw', args: [], envKeys: ['CLAUDE_CONFIG_DIR'] } });
    expect(within(wizard).getByText(/CLAUDE_CONFIG_DIR/)).toBeTruthy();
    expect(bridge.last('accounts-seed-items')).toMatchObject({ name: 'claude-work' });
  });

  it('fills the folder from the host picker', () => {
    const { bridge, push } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: /add account/i })[0]!);
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/source/i), { target: { value: 'folder' } });
    fireEvent.click(within(wizard).getByRole('button', { name: /choose folder/i }));
    expect(bridge.last('accounts-pick-folder')).toBeTruthy();
    push({ type: 'accounts-folder-picked', path: '/picked' });
    expect((within(wizard).getByLabelText(/^folder$/i) as HTMLInputElement).value).toBe('/picked');
  });

  it('rejects a bad name inline before sending', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: /add account/i })[0]!);
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/account name/i), { target: { value: 'Bad Name' } });
    expect(within(wizard).getByText(/lowercase slug/i)).toBeTruthy();
    expect((within(wizard).getByRole('button', { name: /^add$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.last('accounts-add')).toBeUndefined();
  });
});
