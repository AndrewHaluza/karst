import { afterEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter } from '../antigravity.js';
import { ClaudeAdapter } from '../claude.js';
import { CodexAdapter } from '../codex.js';
import { OpencodeAdapter } from '../opencode.js';
import { Opencode2Adapter } from '../opencode2.js';
import { configureAccounts, resetAccounts } from './registry.js';
import { AccountNotFoundError } from './resolve.js';
import type { AccountsConfig } from './types.js';

const acct = (dir: string, extra: object = {}) => ({ kind: 'subscription', source: 'folder', dir, ...extra }) as never;
const adapters = [
  ['claude', () => new ClaudeAdapter(), 'CLAUDE_CONFIG_DIR', 'claude'],
  ['codex', () => new CodexAdapter(), 'CODEX_HOME', 'codex'],
  ['opencode', () => new OpencodeAdapter(), 'XDG_DATA_HOME', 'opencode'],
  ['antigravity', () => new AntigravityAdapter(), 'ANTIGRAVITY_EXECUTABLE_DATA_DIR', 'agy'],
] as const;

afterEach(() => resetAccounts());

describe.each(adapters)('%s interactive command under an account', (core, make, envVar, bin) => {
  it('is unchanged with no accounts configured', () => {
    const cmd = make().buildInteractiveCommand({ cwd: '/wt' });
    expect(cmd.command).toBe(bin);
    expect(cmd.env[envVar]).toBeUndefined();
    expect(cmd.account).toBeUndefined();
  });
  it('sets the home variable and records the account', () => {
    const config: AccountsConfig = { [core]: { active: 'w', list: { w: acct('/h/w') } } };
    configureAccounts(config);
    const cmd = make().buildInteractiveCommand({ cwd: '/wt' });
    expect(cmd.env[envVar]).toBe('/h/w');
    expect(cmd.account).toBe('w');
  });
  it('a recorded account beats the active one; a deleted one throws', () => {
    configureAccounts({ [core]: { active: 'w', list: { w: acct('/h/w'), o: acct('/h/o') } } });
    expect(make().buildInteractiveCommand({ cwd: '/wt', account: 'o' }).env[envVar]).toBe('/h/o');
    expect(make().buildInteractiveCommand({ cwd: '/wt', account: 'default' }).env[envVar]).toBeUndefined();
    expect(() => make().buildInteractiveCommand({ cwd: '/wt', account: 'gone' })).toThrow(AccountNotFoundError);
  });
});

describe('command accounts and opencode2', () => {
  it('a command account replaces the binary and prepends args', () => {
    configureAccounts({ claude: { active: 'c', list: { c: acct('/h/c', { source: 'command', command: '/bin/claude-w', args: ['--x'] }) } } });
    const cmd = new ClaudeAdapter().buildInteractiveCommand({ cwd: '/wt' });
    expect(cmd.command).toBe('/bin/claude-w');
    expect(cmd.args.slice(0, 1)).toEqual(['--x']);
  });
  it('opencode2 keeps its isolation and gets a per-account XDG root', () => {
    configureAccounts({ opencode2: { active: 'a', list: { a: acct('/h/o2') } } });
    const env = new Opencode2Adapter().buildInteractiveCommand({ cwd: '/wt' }).env;
    expect(env['XDG_DATA_HOME']).toBe('/h/o2/data');
    expect(env['DISABLE_AUTOUPDATER']).toBe('1');
    expect(env['OPENCODE_CONFIG_CONTENT']).toBeDefined();
  });
});
