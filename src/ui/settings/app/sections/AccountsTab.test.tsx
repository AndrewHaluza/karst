/**
 * COMPONENT-mode tests for the Accounts tab (D505, T1360): ONE flat accounts
 * table, the single add-account toolbar button with the wizard's Agent select,
 * the row states, the ⋯ menu and the sbx token cell. The host is the test bridge.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountsCoreView, AccountsHostMessage } from '../../accountsMessages.js';
import { DEFAULT_ACCOUNT_LABEL } from '../../accountsMessages.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { AccountsTab } from './AccountsTab.js';
import type { AgentsRoute } from './agentsRoute.js';

afterEach(cleanup);

const CORE = (core: AccountsCoreView['core'], extra: AccountsCoreView['rows'] = [], active = 'default', source: AccountsCoreView['source'] = 'machine', machineDefault = 'default'): AccountsCoreView => ({
  core,
  active,
  machineDefault,
  source,
  rows: [
    { name: 'default', label: 'Default (CLI home)', active: active === 'default', builtIn: true, status: 'signed-in' },
    ...extra,
  ],
});
const WORK = { name: 'work', label: 'work', active: false, builtIn: false, source: 'managed', dir: '/a/work', status: 'not-signed-in' } as const;
const FOLDER = { name: 'fold', label: 'fold', active: false, builtIn: false, source: 'folder', dir: '/h/f', status: 'unknown' } as const;

function mount(cores: AccountsCoreView[] | null = [CORE('claude', [WORK, FOLDER]), CORE('codex'), CORE('opencode')], route: AgentsRoute = { tab: 'accounts' }) {
  const bridge: TestBridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <AccountsTab route={route} navigate={() => {}} />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  const push = (m: AccountsHostMessage): void => { act(() => bridge.push(m)); };
  if (cores !== null) push({ type: 'accounts-state', cores });
  return { bridge, push };
}

const wizardOf = (): HTMLElement => document.querySelector('[data-region="accounts-add-wizard"]') as HTMLElement;
const addAccount = (): void => { fireEvent.click(screen.getByRole('button', { name: '+ Add account' })); };

const rowOf = (name: string): HTMLElement => {
  const rows = Array.from(document.querySelectorAll('.accounts-row'));
  const row = rows.find((r) => r.querySelector('[data-col="name"] .accounts-name')?.textContent === name);
  if (!row) throw new Error(`no accounts row named ${name}`);
  return row as HTMLElement;
};
const cellOf = (name: string, col: string): HTMLElement => rowOf(name).querySelector(`[data-col="${col}"]`) as HTMLElement;
const table = (): HTMLElement => screen.getByRole('table', { name: 'Accounts' });

describe('Accounts tab — one flat table', () => {
  it('asks the host for the accounts on mount', () => {
    const { bridge } = mount();
    expect(bridge.last('accounts-load')).toBeTruthy();
  });

  it('states that the list is shared, the choice is per project, and changes save at once', () => {
    mount();
    expect(screen.getByText(/All projects share the account list\. Each project picks its own active account\. Changes save at once\./)).toBeTruthy();
  });

  it('renders one table whose header labels are Agent | mark | Account | Location | Sign-in | sbx token | use | menu', () => {
    mount();
    const headers = within(table()).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Agent', '', 'Account', 'Location', 'Sign-in', 'sbx token', '', '']);
    expect(document.querySelectorAll('[data-region="accounts-table"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-region="accounts-core-row"]')).toHaveLength(3);
    // The old per-core <section> cards and their <table> markup are gone.
    expect(document.querySelectorAll('.accounts-core')).toHaveLength(0);
    expect(document.querySelector('table')).toBeNull();
  });

  it('names each core (icon + name) only on the first row of its rowgroup', () => {
    mount();
    const groups = Array.from(document.querySelectorAll('[data-region="accounts-core-row"]'));
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['claude accounts', 'codex accounts', 'opencode accounts']);

    const first = groups[0]!.querySelectorAll('.accounts-row');
    expect(first).toHaveLength(3);
    expect(first[0]!.querySelector('[data-col="agent"]')!.textContent).toBe('Claude Code');
    expect(first[0]!.querySelector('[data-col="agent"] .agenticon')).not.toBeNull();
    for (const row of [first[1]!, first[2]!]) {
      const agent = row.querySelector('[data-col="agent"]') as HTMLElement;
      // Every row keeps its Agent cell in the accessibility tree; hiding it (or
      // dropping it) shifts every later column left, so the row stops lining up
      // with the headers. Later rows carry the core name visually hidden.
      expect(agent.getAttribute('aria-hidden')).toBeNull();
      expect(agent.textContent).toBe('Claude Code');
      expect(agent.querySelector('.sr-only')?.textContent).toBe('Claude Code');
    }
    expect(groups[1]!.querySelector('[data-col="agent"]')!.textContent).toBe('Codex');
  });

  it('marks the multi-account and selected rowgroups without changing the others', () => {
    mount([CORE('claude', [WORK]), CORE('codex')], { tab: 'accounts', selected: 'claude' });
    const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-region="accounts-core-row"]'));
    expect(groups[0]!.className).toContain('is-multi');
    expect(groups[0]!.className).toContain('is-selected');
    expect(groups[1]!.className).not.toContain('is-multi');
    expect(groups[1]!.className).not.toContain('is-selected');
  });

  it('removed the old select, chip, chip column and row buttons', () => {
    mount();
    expect(screen.queryByLabelText('Active account')).toBeNull();
    expect(screen.queryByRole('button', { name: /set active/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^use machine default$/i })).toBeNull();
    expect(screen.queryByText(/only the default account exists/i)).toBeNull();
    expect(document.querySelector('.accounts-source-chip')).toBeNull();
    expect(document.querySelector('.k-chip')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Command' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Source' })).toBeNull();
  });

  it('shows a loading line and disables Add account until the host answers', () => {
    mount(null);
    expect(screen.getByText('Loading accounts…')).toBeTruthy();
    expect((screen.getByRole('button', { name: '+ Add account' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Accounts tab — the single add-account toolbar', () => {
  it('offers exactly one + Add account button in the toolbar', () => {
    mount();
    const toolbar = document.querySelector('[data-region="accounts-toolbar"]') as HTMLElement;
    expect(within(toolbar).getAllByRole('button')).toHaveLength(1);
    expect(within(toolbar).getByRole('button', { name: '+ Add account' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '+ Add account' })).toHaveLength(1);
  });

  it('opens the wizard under the toolbar with the first core as the Agent default', () => {
    mount();
    addAccount();
    const wizard = wizardOf();
    expect(within(wizard).getByLabelText('Agent')).toBeTruthy();
    expect((within(wizard).getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude');
    expect((document.querySelector('[data-region="accounts-toolbar"]')!.nextElementSibling)).toBe(wizard);
  });

  it('starts on the selected route core, and on the first core when the route names an unknown one', () => {
    mount(undefined, { tab: 'accounts', selected: 'codex' });
    addAccount();
    expect((within(wizardOf()).getByLabelText('Agent') as HTMLSelectElement).value).toBe('codex');
    cleanup();
    mount(undefined, { tab: 'accounts', selected: 'not-a-core' });
    addAccount();
    expect((within(wizardOf()).getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude');
  });

  it('adds for the chosen agent', () => {
    const { bridge } = mount();
    addAccount();
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText('Agent'), { target: { value: 'codex' } });
    fireEvent.change(within(wizard).getByLabelText(/account name/i), { target: { value: 'two' } });
    fireEvent.click(within(wizard).getByRole('button', { name: /^add$/i }));
    expect(bridge.last('accounts-add')).toMatchObject({ core: 'codex', name: 'two', spec: { source: 'managed' } });
  });

  it('resets the step state when the Agent changes', () => {
    const { push } = mount();
    addAccount();
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/account name/i), { target: { value: 'two' } });
    fireEvent.click(within(wizard).getByRole('button', { name: /^add$/i }));
    push({ type: 'accounts-added', core: 'claude', name: 'two', status: 'signed-in' });
    push({ type: 'accounts-seed', core: 'claude', name: 'two', items: [{ id: 'settings', label: 'Settings', checked: true }] });
    expect(document.querySelector('[data-region="accounts-copy-checklist"]')).toBeTruthy();
    fireEvent.change(within(wizard).getByLabelText('Agent'), { target: { value: 'codex' } });
    expect(document.querySelector('[data-region="accounts-copy-checklist"]')).toBeNull();
    expect(document.querySelector('[data-region="accounts-source-step"]')).toBeTruthy();
  });

  it('closes the wizard without touching the list', () => {
    mount();
    addAccount();
    fireEvent.click(within(wizardOf()).getByRole('button', { name: /^cancel$/i }));
    expect(document.querySelector('[data-region="accounts-add-wizard"]')).toBeNull();
  });

  it('keeps the wizard core as the Agent select value for its aria-label', () => {
    const { push } = mount();
    addAccount();
    const wizard = wizardOf();
    expect(wizard.getAttribute('aria-label')).toBe('Add claude account');
    fireEvent.change(within(wizard).getByLabelText('Agent'), { target: { value: 'opencode' } });
    expect(wizard.getAttribute('aria-label')).toBe('Add opencode account');
    fireEvent.change(within(wizard).getByLabelText(/account name/i), { target: { value: 'oc' } });
    fireEvent.click(within(wizard).getByRole('button', { name: /^add$/i }));
    push({ type: 'accounts-added', core: 'opencode', name: 'oc', status: 'unknown' });
    push({ type: 'accounts-seed', core: 'opencode', name: 'oc', items: [] });
    expect(within(wizard).getByText(/config is already shared/i)).toBeTruthy();
  });
});

describe('Accounts tab — choosing the active account', () => {
  it('uses an inactive row and notes that running sessions keep theirs (once)', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Use work (Claude Code)' }));
    expect(bridge.last('accounts-set-active')).toMatchObject({ core: 'claude', name: 'work' });
    expect(screen.getAllByText(/running sessions keep their account/i)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Use fold (Claude Code)' }));
    expect(screen.getAllByText(/running sessions keep their account/i)).toHaveLength(1);
  });

  it('moves the check with the active account and puts Use on the row it left', () => {
    const { push } = mount([CORE('claude', [WORK, FOLDER]), CORE('codex')]);
    fireEvent.click(screen.getByRole('button', { name: 'Use work (Claude Code)' }));
    push({ type: 'accounts-state', cores: [CORE('claude', [{ ...WORK, active: true }, FOLDER], 'work'), CORE('codex')] });
    const work = rowOf('work');
    expect(work.className).toContain('is-active');
    expect(within(work).getByRole('img', { name: 'Active' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use work (Claude Code)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Use Default (Claude Code)' })).toBeTruthy();
    expect(within(rowOf('Default')).queryByRole('img', { name: 'Active' })).toBeNull();
  });

  it('offers an inline Reset for a project choice, with the machine-default accessible name', () => {
    const { bridge } = mount([CORE('claude', [{ ...WORK, active: true }], 'work', 'project')]);
    expect(within(rowOf('work')).getByText('this project')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use the machine default for claude' }));
    expect(bridge.last('accounts-clear-project-choice')).toMatchObject({ core: 'claude' });
  });

  it('shows no project choice or Reset for the machine default', () => {
    mount();
    expect(screen.queryByText('this project')).toBeNull();
    expect(screen.queryByRole('button', { name: /use the machine default/i })).toBeNull();
  });
});

describe('Accounts tab — account name and location cells', () => {
  it('shows the built-in account as Default and CLI home without changing the host label', () => {
    mount();
    const row = rowOf('Default');
    expect(within(row).getByText('Default')).toBeTruthy();
    expect(within(row).getByText('CLI home')).toBeTruthy();
    expect(DEFAULT_ACCOUNT_LABEL).toBe('Default (CLI home)');
  });

  it('shortens home-anchored paths to ~, with the full path in the title', () => {
    mount([CORE('claude', [{ ...WORK, dir: '/Users/nd/Projects/work' }, { ...FOLDER, dir: '/home/nd/fold' }])]);
    const user = cellOf('work', 'location');
    expect(user.textContent).toBe('~/Projects/work');
    expect(user.querySelector('.accounts-loc-mono')!.getAttribute('title')).toBe('/Users/nd/Projects/work');
    expect(cellOf('fold', 'location').textContent).toBe('~/fold');

    cleanup();
    mount([CORE('claude', [{ ...WORK, dir: 'C:\\Users\\nd\\Work' }])]);
    expect(cellOf('work', 'location').textContent).toBe('~\\Work');
  });

  it('shows Managed for a managed account with no folder and the command for a command account', () => {
    mount([CORE('claude', [
      { name: 'managed', label: 'managed', active: false, builtIn: false, source: 'managed', status: 'unknown' },
      { name: 'cmd', label: 'cmd', active: false, builtIn: false, source: 'command', command: 'claude-ci --profile ci', status: 'unknown' },
    ])]);
    expect(cellOf('managed', 'location').textContent).toBe('Managed');
    const cmd = cellOf('cmd', 'location');
    expect(cmd.textContent).toBe('claude-ci --profile ci');
    expect(cmd.querySelector('.accounts-loc-mono')!.getAttribute('title')).toBe('claude-ci --profile ci');
  });

  it('never uses the old Source or Command columns for these values', () => {
    mount();
    expect(screen.queryByText('Managed', { selector: '[data-col="source"]' })).toBeNull();
  });
});

describe('Accounts tab — sign-in status', () => {
  const statusOf = (name: string): HTMLElement => cellOf(name, 'status');

  it('shows a dot and a word, never a chip, for each status', () => {
    mount();
    expect(statusOf('Default').querySelector('.accounts-status-dot')!.className).toContain('is-signed-in');
    expect(statusOf('Default').textContent).toContain('Signed in');
    expect(statusOf('work').querySelector('.accounts-status-dot')!.className).toContain('is-not-signed-in');
    expect(statusOf('work').querySelector('.accounts-status-warn')!.textContent).toBe('Not signed in');
    expect(statusOf('fold').querySelector('.accounts-status-dot')!.className).toContain('is-unknown');
    expect(statusOf('fold').textContent).toContain('Not checked');
    expect(table().querySelector('.k-chip')).toBeNull();
  });

  it('puts Log in inline for an account that is not signed in', () => {
    const { bridge } = mount();
    fireEvent.click(within(statusOf('work')).getByRole('button', { name: 'Log in work' }));
    expect(bridge.last('accounts-login')).toMatchObject({ core: 'claude', name: 'work' });
  });

  it('offers no Log in for a signed-in account', () => {
    mount();
    expect(within(statusOf('Default')).queryByRole('button', { name: /log in/i })).toBeNull();
  });

  it('keeps Log in for an account whose sign-in status is not checked (UI-R37)', () => {
    const { bridge } = mount();
    const status = statusOf('fold');
    expect(status.textContent).toContain('Not checked');
    fireEvent.click(within(status).getByRole('button', { name: 'Log in fold' }));
    expect(bridge.last('accounts-login')).toMatchObject({ core: 'claude', name: 'fold' });
  });
});

describe('Accounts tab — the ⋯ row menu', () => {
  const menuTrigger = (name: string): HTMLElement => screen.getByRole('button', { name: `More actions for ${name} (Claude Code)` });

  it('holds only Make machine default and Delete', () => {
    mount();
    fireEvent.click(menuTrigger('work'));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Make machine default', 'Delete']);
    expect(screen.queryByRole('menuitem', { name: /log in/i })).toBeNull();
  });

  it('renders no trigger for a built-in machine default', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'More actions for Default (Claude Code)' })).toBeNull();
  });

  it('makes a row the machine default', () => {
    const { bridge } = mount();
    fireEvent.click(menuTrigger('work'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make work the machine default' }));
    expect(bridge.last('accounts-set-machine-default')).toMatchObject({ core: 'claude', name: 'work' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('navigates with the keyboard and closes on Escape, returning focus to the trigger', () => {
    mount();
    const trigger = menuTrigger('work');
    trigger.focus();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'More actions for work (Claude Code)' });
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger after an item runs (UI-R23)', () => {
    const { bridge } = mount();
    const trigger = menuTrigger('work');
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make work the machine default' }));
    expect(bridge.last('accounts-set-machine-default')).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when its items disappear and does not reopen when they return', () => {
    const { push } = mount([CORE('claude', [], 'default', 'machine', 'work')]);
    fireEvent.click(menuTrigger('Default'));
    expect(screen.getByRole('menu')).toBeTruthy();
    push({ type: 'accounts-state', cores: [CORE('claude')] });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions for Default (Claude Code)' })).toBeNull();
    push({ type: 'accounts-state', cores: [CORE('claude', [], 'default', 'machine', 'work')] });
    expect(menuTrigger('Default').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Accounts tab — inline delete confirmation', () => {
  const openDelete = (name: string): HTMLElement => {
    const trigger = screen.getByRole('button', { name: `More actions for ${name} (Claude Code)` });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: `Delete ${name}` }));
    const box = document.querySelector('[data-region="accounts-delete-confirm"]');
    if (box === null) throw new Error(`no delete confirmation for ${name}`);
    return box as HTMLElement;
  };

  it('opens directly under the row as a row with one spanning cell, with a folder choice for a managed account', () => {
    const { bridge } = mount();
    const box = openDelete('work');
    expect(box.getAttribute('data-region')).toBe('accounts-delete-confirm');
    // A rowgroup may contain rows only: the confirmation is a row > cell, never a
    // role="group" placed straight inside the rowgroup.
    expect(box.getAttribute('role')).toBe('cell');
    expect(Number(box.getAttribute('aria-colspan'))).toBe(screen.getAllByRole('columnheader').length);
    expect(box.getAttribute('aria-label')).toBe('Delete work');
    const row = box.parentElement as HTMLElement;
    expect(row.getAttribute('role')).toBe('row');
    const group = row.closest('[role="rowgroup"]') as HTMLElement;
    expect(group).not.toBeNull();
    for (const child of Array.from(group.children)) expect(child.getAttribute('role')).toBe('row');
    // It sits right under the account's own row.
    expect(row.previousElementSibling).toBe(rowOf('work'));
    const folder = within(box).getByLabelText(/also remove its folder/i) as HTMLInputElement;
    fireEvent.click(folder);
    fireEvent.click(within(box).getByRole('button', { name: /^delete$/i }));
    expect(bridge.last('accounts-delete')).toMatchObject({ core: 'claude', name: 'work', removeFolder: true });
  });

  it('never offers to remove the folder of a folder account', () => {
    mount();
    const box = openDelete('fold');
    expect(within(box).queryByLabelText(/also remove its folder/i)).toBeNull();
    expect(within(box).getByText(/keeps your folder/i)).toBeTruthy();
  });

  it('names the core by its display name in the delete question', () => {
    mount();
    expect(openDelete('work').textContent).toContain('Delete the Claude Code account work?');
  });

  it('shows the host reason when a delete is refused', () => {
    const { push } = mount();
    openDelete('work');
    push({ type: 'accounts-error', core: 'claude', op: 'accounts-delete', message: 'used by a live session. Stop the session first.' });
    expect(screen.getByRole('alert').textContent).toMatch(/live session/);
  });

  it('does not reopen a closed confirmation when the same name is added again', () => {
    const { push } = mount();
    openDelete('work');
    push({ type: 'accounts-state', cores: [CORE('claude', [FOLDER]), CORE('codex'), CORE('opencode')] });
    expect(document.querySelector('[data-region="accounts-delete-confirm"]')).toBeNull();
    push({ type: 'accounts-state', cores: [CORE('claude', [WORK, FOLDER]), CORE('codex'), CORE('opencode')] });
    expect(document.querySelector('[data-region="accounts-delete-confirm"]')).toBeNull();
  });
});

describe('Accounts tab — the add wizard flows still work', () => {
  it('walks the managed add flow: source, copy, sign in', () => {
    const { bridge, push } = mount();
    addAccount();
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

  it('sends pasted alias text with the alias name found in it', () => {
    const { bridge } = mount();
    addAccount();
    fireEvent.change(within(wizardOf()).getByLabelText(/source/i), { target: { value: 'command' } });
    const imp = document.querySelector('[data-region="accounts-alias-import"]') as HTMLElement;
    const text = "alias cw='CLAUDE_CONFIG_DIR=$HOME/.cw claude'";
    fireEvent.change(within(imp).getByLabelText(/alias/i), { target: { value: text } });
    fireEvent.click(within(imp).getByRole('button', { name: /import alias/i }));
    expect(bridge.last('accounts-import-alias')).toMatchObject({ core: 'claude', alias: 'cw', text });
  });

  it('refuses pasted text with no alias name without asking the host', () => {
    const { bridge } = mount();
    addAccount();
    fireEvent.change(within(wizardOf()).getByLabelText(/source/i), { target: { value: 'command' } });
    const imp = document.querySelector('[data-region="accounts-alias-import"]') as HTMLElement;
    fireEvent.change(within(imp).getByLabelText(/alias/i), { target: { value: 'some words here' } });
    fireEvent.click(within(imp).getByRole('button', { name: /import alias/i }));
    expect(bridge.last('accounts-import-alias')).toBeUndefined();
    expect(within(imp).getByText(/no alias name/i)).toBeTruthy();
  });

  it('fills the folder from the host picker', () => {
    const { bridge, push } = mount();
    addAccount();
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/source/i), { target: { value: 'folder' } });
    fireEvent.click(within(wizard).getByRole('button', { name: /choose folder/i }));
    expect(bridge.last('accounts-pick-folder')).toBeTruthy();
    push({ type: 'accounts-folder-picked', path: '/picked' });
    expect((within(wizard).getByLabelText(/^folder$/i) as HTMLInputElement).value).toBe('/picked');
  });

  it('rejects a bad name inline before sending', () => {
    const { bridge } = mount();
    addAccount();
    const wizard = wizardOf();
    fireEvent.change(within(wizard).getByLabelText(/account name/i), { target: { value: 'Bad Name' } });
    expect(within(wizard).getByText(/lowercase slug/i)).toBeTruthy();
    expect((within(wizard).getByRole('button', { name: /^add$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.last('accounts-add')).toBeUndefined();
  });
});

describe('Accounts tab — sbx token cell (D651)', () => {
  const TOKEN_ROWS = [
    { ...WORK, sbxToken: 'not-set' },
    { ...FOLDER, sbxToken: 'set' },
    { name: 'cmd', label: 'cmd', active: false, builtIn: false, source: 'command', command: 'claude', status: 'unknown' },
  ] as const;
  const mountTokens = () => mount([CORE('claude', [...TOKEN_ROWS]), CORE('codex', [{ ...WORK, name: 'cw', label: 'cw' }])]);

  it('keeps the sbx token column, including its deep-link row key', () => {
    mountTokens();
    expect(cellOf('work', 'sbx-token').getAttribute('data-sbx-token-row')).toBe('claude/work');
    expect(screen.getByRole('columnheader', { name: 'sbx token' })).toBeTruthy();
  });

  it("shows a blank cell with sr-only 'none' and no action for default, command and non-claude rows", () => {
    mountTokens();
    for (const name of ['Default', 'cmd', 'cw']) {
      const cell = cellOf(name, 'sbx-token');
      expect(cell.textContent).toBe('none');
      expect(cell.querySelector('.sr-only')).not.toBeNull();
      expect(within(cell).queryAllByRole('button').length).toBe(0);
    }
  });

  it('sends the set request with no value, then shows saving until the host answers', () => {
    const { bridge, push } = mountTokens();
    fireEvent.click(within(cellOf('work', 'sbx-token')).getByRole('button', { name: 'Set token work' }));
    expect(bridge.last('accounts-set-sbx-token')).toMatchObject({ type: 'accounts-set-sbx-token', core: 'claude', name: 'work' });
    expect(Object.keys(bridge.last('accounts-set-sbx-token') as object).sort()).not.toContain('token');
    expect(cellOf('work', 'sbx-token').textContent).toContain('Saving');
    push({ type: 'accounts-state', cores: [CORE('claude', [{ ...WORK, sbxToken: 'set' }, { ...FOLDER, sbxToken: 'set' }])] });
    expect(cellOf('work', 'sbx-token').textContent).toContain('Saving'); // an unrelated state push does not end the op
    push({ type: 'accounts-token-done', core: 'claude', name: 'work' });
    expect(cellOf('work', 'sbx-token').textContent).toContain('Set');
    expect(within(cellOf('work', 'sbx-token')).getByRole('button', { name: 'Remove token work' })).toBeTruthy();
  });

  it('says the token status is unknown when the host could not read the keychain', () => {
    const { push } = mountTokens();
    push({ type: 'accounts-state', cores: [CORE('claude', [{ ...WORK, sbxToken: 'unknown' }, FOLDER])] });
    expect(cellOf('work', 'sbx-token').textContent).toContain('Token status unknown');
    expect(within(cellOf('work', 'sbx-token')).getByRole('button', { name: 'Set token work' })).toBeTruthy();
  });

  it('focuses the token control of the account named in the route', () => {
    mount([CORE('claude', [...TOKEN_ROWS]), CORE('codex')], { tab: 'accounts', selected: 'claude', account: 'work' });
    expect(document.activeElement).toBe(within(cellOf('work', 'sbx-token')).getByRole('button', { name: 'Set token work' }));
  });

  it('focuses nothing when the route names no account', () => {
    mountTokens();
    expect(document.activeElement).toBe(document.body);
  });

  it('shows the host error and keeps the Set token action when the token is invalid', () => {
    const { push } = mountTokens();
    fireEvent.click(within(cellOf('work', 'sbx-token')).getByRole('button', { name: 'Set token work' }));
    push({ type: 'accounts-error', core: 'claude', op: 'accounts-set-sbx-token', message: 'The token must start with sk-ant-oat' });
    expect(within(cellOf('work', 'sbx-token')).getByRole('alert').textContent).toMatch(/must start with/);
    expect(within(cellOf('work', 'sbx-token')).getByRole('button', { name: 'Set token work' })).toBeTruthy();
  });

  it('asks to confirm before it removes a token', () => {
    const { bridge } = mountTokens();
    const cell = cellOf('fold', 'sbx-token');
    expect(cell.textContent).toContain('Set');
    fireEvent.click(within(cell).getByRole('button', { name: 'Remove token fold' }));
    expect(bridge.last('accounts-remove-sbx-token')).toBeUndefined();
    fireEvent.click(within(cell).getByRole('button', { name: 'Cancel' }));
    expect(within(cell).getByRole('button', { name: 'Remove token fold' })).toBeTruthy();
    fireEvent.click(within(cell).getByRole('button', { name: 'Remove token fold' }));
    fireEvent.click(within(cell).getByRole('button', { name: 'Confirm remove token fold' }));
    expect(bridge.last('accounts-remove-sbx-token')).toMatchObject({ core: 'claude', name: 'fold' });
    expect(cell.textContent).toContain('Saving');
  });

  it('shows the setup-token hint once, under the table, only when a row can hold a token', () => {
    mountTokens();
    const hints = document.querySelectorAll('[data-hint="sbx-token"]');
    expect(hints).toHaveLength(1);
    expect(hints[0]!.textContent).toBe('sbx token: run claude setup-token, then paste the token. Each editor keeps its own token.');
    cleanup();
    mount();
    expect(document.querySelector('[data-hint="sbx-token"]')).toBeNull();
  });
});

describe('Accounts tab — accessible names', () => {
  it('names every row action', () => {
    mount([CORE('claude', [{ ...WORK, active: true }], 'work', 'project')]);
    expect(screen.getByRole('button', { name: 'Use Default (Claude Code)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More actions for work (Claude Code)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use the machine default for claude' })).toBeTruthy();
    const active = rowOf('work').querySelector('[role="img"]') as HTMLElement;
    expect(active.getAttribute('aria-label')).toBe('Active');
  });
});
