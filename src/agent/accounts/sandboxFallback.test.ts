import { afterEach, expect, it } from 'vitest';
import { resolveBackend } from '../backendResolver.js';
import { configureAccounts, resetAccounts } from './registry.js';

afterEach(() => resetAccounts());

it('falls back to the host when the active account is a command account (docker and sbx)', async () => {
  configureAccounts({
    claude: { active: 'x', list: { x: { kind: 'subscription', source: 'command', command: 'claude-x', dir: '/h/x' } } },
  });
  for (const backend of ['docker', 'sbx'] as const) {
    const r = await resolveBackend({
      backends: { claude: backend } as never, core: 'claude', projectRoot: '/p', ticketId: 1,
    });
    expect(r.line).toMatch(/^host \(claude account 'x' runs the host command 'claude-x'/);
  }
});

it('checks the account that was passed (the recorded one of a resume), not the active one', async () => {
  configureAccounts({
    claude: { active: 'f', list: {
      f: { kind: 'subscription', source: 'folder', dir: '/h/f' },
      x: { kind: 'subscription', source: 'command', command: 'claude-x', dir: '/h/x' },
    } },
  });
  const input = { backends: { claude: 'docker' } as never, core: 'claude', projectRoot: '/p', ticketId: 1 };
  expect((await resolveBackend({ ...input, account: 'x' })).line).toMatch(/^host \(claude account 'x' runs the host command/);
  expect((await resolveBackend({ ...input })).line).not.toMatch(/runs the host command/);
});
