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

function mount(cores: AccountsCoreView[] = [CORE('claude', [WORK, FOLDER]), CORE('codex'), CORE('opencode')], route: AgentsRoute = { tab: 'accounts' }) {
  const bridge: TestBridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <AccountsTab route={route} navigate={() => {}} />
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
    expect(screen.getByText(/not on Save/i)).toBeTruthy();
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

describe('Accounts tab sbx token cell (D651)', () => {
  const TOKEN_ROWS = [
    { ...WORK, sbxToken: 'not-set' },
    { ...FOLDER, sbxToken: 'set' },
    { name: 'cmd', label: 'cmd', active: false, builtIn: false, source: 'command', command: 'claude', status: 'unknown' },
  ] as const;
  const mountTokens = () => mount([CORE('claude', [...TOKEN_ROWS]), CORE('codex', [{ ...WORK, name: 'cw', label: 'cw' }])]);
  const cellOf = (name: string): HTMLElement => {
    const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.querySelector('[data-col="name"]')?.textContent?.startsWith(name));
    return tr!.querySelector('[data-col="sbx-token"]') as HTMLElement;
  };

  it('has an sbx token column that reads as a labelled card cell', () => {
    mountTokens();
    expect(cellOf('work').getAttribute('data-label')).toBe('sbx token');
    expect(document.querySelector('th')?.parentElement?.textContent).toContain('sbx token');
  });

  it("shows '—' and no action for default, command and non-claude rows", () => {
    mountTokens();
    for (const name of ['Default', 'cmd', 'cw']) {
      const cell = cellOf(name);
      expect(cell.textContent).toBe('—');
      expect(within(cell).queryAllByRole('button').length).toBe(0);
    }
  });

  it('sends the set request with no value, then shows saving until the host answers', () => {
    const { bridge, push } = mountTokens();
    fireEvent.click(within(cellOf('work')).getByRole('button', { name: 'Set token work' }));
    expect(bridge.last('accounts-set-sbx-token')).toMatchObject({ type: 'accounts-set-sbx-token', core: 'claude', name: 'work' });
    expect(Object.keys(bridge.last('accounts-set-sbx-token') as object).sort()).not.toContain('token');
    expect(cellOf('work').textContent).toContain('Saving');
    push({ type: 'accounts-state', cores: [CORE('claude', [{ ...WORK, sbxToken: 'set' }, { ...FOLDER, sbxToken: 'set' }])] });
    expect(cellOf('work').textContent).toContain('Saving'); // an unrelated state push does not end the op
    push({ type: 'accounts-token-done', core: 'claude', name: 'work' });
    expect(cellOf('work').textContent).toContain('Token set');
  });

  it('says the token status is unknown when the host could not read the keychain', () => {
    const { push } = mountTokens();
    push({ type: 'accounts-state', cores: [CORE('claude', [{ ...WORK, sbxToken: 'unknown' }, FOLDER])] });
    expect(cellOf('work').textContent).toContain('Token status unknown');
    expect(within(cellOf('work')).getByRole('button', { name: 'Set token work' })).toBeTruthy();
  });

  it('focuses the token control of the account named in the route', () => {
    mount([CORE('claude', [...TOKEN_ROWS]), CORE('codex')], { tab: 'accounts', selected: 'claude', account: 'work' });
    expect(document.activeElement).toBe(within(cellOf('work')).getByRole('button', { name: 'Set token work' }));
  });

  it('focuses nothing when the route names no account', () => {
    mount([CORE('claude', [...TOKEN_ROWS]), CORE('codex')]);
    expect(document.activeElement).toBe(document.body);
  });

  it('shows the host error and keeps the Set token action when the token is invalid', () => {
    const { push } = mountTokens();
    fireEvent.click(within(cellOf('work')).getByRole('button', { name: 'Set token work' }));
    push({ type: 'accounts-error', core: 'claude', op: 'accounts-set-sbx-token', message: 'The token must start with sk-ant-oat' });
    expect(within(cellOf('work')).getByRole('alert').textContent).toMatch(/must start with/);
    expect(within(cellOf('work')).getByRole('button', { name: 'Set token work' })).toBeTruthy();
  });

  it('asks to confirm before it removes a token', () => {
    const { bridge } = mountTokens();
    expect(cellOf('fold').textContent).toContain('Token set');
    fireEvent.click(within(cellOf('fold')).getByRole('button', { name: 'Remove token fold' }));
    expect(bridge.last('accounts-remove-sbx-token')).toBeUndefined();
    fireEvent.click(within(cellOf('fold')).getByRole('button', { name: 'Cancel' }));
    expect(within(cellOf('fold')).getByRole('button', { name: 'Remove token fold' })).toBeTruthy();
    fireEvent.click(within(cellOf('fold')).getByRole('button', { name: 'Remove token fold' }));
    fireEvent.click(within(cellOf('fold')).getByRole('button', { name: 'Confirm remove token fold' }));
    expect(bridge.last('accounts-remove-sbx-token')).toMatchObject({ core: 'claude', name: 'fold' });
    expect(cellOf('fold').textContent).toContain('Saving');
  });

  it('shows the setup-token hint only when a row can hold a token', () => {
    mountTokens();
    const hint = document.querySelector('[data-hint="sbx-token"]');
    expect(hint?.textContent).toBe('Run claude setup-token, then paste the token. Each editor (Cursor, VS Code) keeps its own token.');
    cleanup();
    mount();
    expect(document.querySelector('[data-hint="sbx-token"]')).toBeNull();
  });
});

describe('Accounts table readability (D707)', () => {
  it('names the core canonically, not by id', () => {
    mount();
    const heads = Array.from(document.querySelectorAll('.accounts-core-head h3')).map((h) => h.textContent);
    expect(heads).toEqual(['Claude Code', 'Codex', 'OpenCode']);
  });

  it('labels the select Active account', () => {
    mount();
    expect(screen.getAllByLabelText('Active account').length).toBe(3);
  });

  it('shows an Active chip, not (active) text', () => {
    mount();
    const row = document.querySelector('tr.is-active') as HTMLElement;
    expect(row.querySelector('.k-chip')!.textContent).toBe('Active');
    expect(row.textContent).not.toContain('(active)');
  });

  it("empty Source, Folder and Command cells hold only 'none' for screen readers", () => {
    mount();
    const row = document.querySelector('tr.is-active') as HTMLElement;
    for (const col of ['source', 'dir', 'command']) {
      const cell = row.querySelector(`[data-col="${col}"]`)!;
      expect(cell.textContent).toBe('none');
      expect(cell.querySelector('.sr-only')).not.toBeNull();
    }
  });

  it('keeps real values in filled cells', () => {
    mount();
    const row = Array.from(document.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes('/a/work')) as HTMLElement;
    expect(row.querySelector('[data-col="source"]')!.textContent).toBe('Managed');
  });

  it('renders Log in as a secondary button', () => {
    mount();
    const btn = screen.getAllByRole('button', { name: /log in/i })[0]!;
    expect(btn.className).toContain('secondary');
  });
});

describe('Accounts tab: active account per project', () => {
  it('says the list is shared and the active account is per project', () => {
    mount();
    expect(screen.getByText(/account list is shared/i)).toBeTruthy();
    expect(screen.getByText(/active account is per project/i)).toBeTruthy();
  });
  it('shows the machine default chip when the project has no choice', () => {
    mount();
    const row = document.querySelector('[data-region="accounts-core-row"]') as HTMLElement;
    expect(within(row).getByText('machine default', { selector: '[data-source]' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /use the machine default/i })).toBeNull();
  });
  it('shows the project chip and a control that clears the choice', () => {
    const { bridge } = mount([CORE('claude', [{ ...WORK, active: true }], 'work', 'project')]);
    const row = document.querySelector('[data-region="accounts-core-row"]') as HTMLElement;
    expect(within(row).getByText('this project', { selector: '[data-source]' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: /use the machine default for claude/i }));
    expect(bridge.last('accounts-clear-project-choice')).toMatchObject({ core: 'claude' });
  });
  it('a row control makes that account the machine default', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByRole('button', { name: /make work the machine default/i }));
    expect(bridge.last('accounts-set-machine-default')).toMatchObject({ core: 'claude', name: 'work' });
  });
  it('the set-active control still sets the choice of this project', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByRole('button', { name: /set work active/i }));
    expect(bridge.last('accounts-set-active')).toMatchObject({ core: 'claude', name: 'work' });
  });
});
