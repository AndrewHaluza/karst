import { beforeEach, describe, expect, it, vi } from 'vitest';

const show = vi.fn();
const createTerminal = vi.fn((_o: unknown) => ({ show }));
const showOpenDialog = vi.fn();
vi.mock('vscode', () => ({ window: { createTerminal: (o: unknown) => createTerminal(o), showOpenDialog: (o: unknown) => showOpenDialog(o) } }));

const { bindAccountsHost } = await import('./accountsHostBinding.js');

function ops(): never {
  return {
    loginCommand: async () => ({ binary: 'claude-w', args: ['/login'], env: { CLAUDE_CONFIG_DIR: '/h/w' } }),
  } as never;
}

beforeEach(() => { show.mockClear(); createTerminal.mockClear(); showOpenDialog.mockReset(); });

describe('bindAccountsHost', () => {
  it('opens a shown terminal for the account login command', async () => {
    const host = bindAccountsHost(ops(), () => {});
    await host.handle({ type: 'accounts-login', core: 'claude', name: 'w' });
    expect(createTerminal).toHaveBeenCalledWith({
      name: 'Karst login: claude/w', shellPath: 'claude-w', shellArgs: ['/login'], env: { CLAUDE_CONFIG_DIR: '/h/w' },
    });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('asks for one folder and posts its path', async () => {
    showOpenDialog.mockResolvedValue([{ fsPath: '/picked' }]);
    const posted: unknown[] = [];
    await bindAccountsHost(ops(), (m) => posted.push(m)).handle({ type: 'accounts-pick-folder' });
    expect(showOpenDialog).toHaveBeenCalledWith({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use folder' });
    expect(posted).toEqual([{ type: 'accounts-folder-picked', path: '/picked' }]);
  });

  it('posts nothing when the picker is cancelled or empty', async () => {
    const posted: unknown[] = [];
    const host = bindAccountsHost(ops(), (m) => posted.push(m));
    showOpenDialog.mockResolvedValue(undefined);
    await host.handle({ type: 'accounts-pick-folder' });
    showOpenDialog.mockResolvedValue([]);
    await host.handle({ type: 'accounts-pick-folder' });
    expect(posted).toEqual([]);
  });
});
