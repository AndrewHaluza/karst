import { afterEach, describe, expect, it } from 'vitest';
import {
  accountForLaunch, accountReaderEnv, configureAccounts, configureRecordedAccountLookup,
  resetAccounts, sandboxAccountBlock,
} from './registry.js';
import type { AccountsConfig } from './types.js';

const config: AccountsConfig = {
  claude: {
    active: 'work',
    list: {
      work: { kind: 'subscription', source: 'folder', dir: '/h/work' },
      cmd: { kind: 'subscription', source: 'command', command: 'claude-x', dir: '/h/cmd' },
    },
  },
  codex: { active: 'c1', list: { c1: { kind: 'subscription', source: 'folder', dir: '/h/codex1' } } },
};

afterEach(() => {
  resetAccounts();
  configureRecordedAccountLookup(undefined);
});

describe('accountReaderEnv', () => {
  it('returns the base env untouched with no accounts', () => {
    const env = accountReaderEnv({ CLAUDE_CONFIG_DIR: '/base' } as NodeJS.ProcessEnv);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/base');
  });
  it('reads the active account folder at read time', () => {
    const env = accountReaderEnv({ HOME: '/u' } as NodeJS.ProcessEnv);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    configureAccounts(config);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/h/work');
    expect(env.CODEX_HOME).toBe('/h/codex1');
    expect(env.HOME).toBe('/u');
  });
  it('pins a recorded account per core', () => {
    configureAccounts(config);
    const env = accountReaderEnv({} as NodeJS.ProcessEnv, { claude: 'cmd' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/h/cmd');
  });
});

describe('accountForLaunch', () => {
  it('prefers an explicit account', () => {
    expect(accountForLaunch('claude', 's1', 'work')).toBe('work');
  });
  it('is undefined for a fresh launch (the active account applies)', () => {
    expect(accountForLaunch('claude', undefined)).toBeUndefined();
  });
  it('uses the recorded account of a resume, and pins default for a NULL record', () => {
    configureRecordedAccountLookup((core, id) => (id === 's1' ? 'work' : id === 's2' ? null : undefined));
    expect(accountForLaunch('claude', 's1')).toBe('work');
    expect(accountForLaunch('claude', 's2')).toBe('default');
    expect(accountForLaunch('claude', 's3')).toBeUndefined();
  });
});

describe('sandboxAccountBlock', () => {
  it('blocks only a command account, with a reason', () => {
    configureAccounts({ claude: { ...config.claude!, active: 'cmd' } });
    expect(sandboxAccountBlock('claude')).toMatch(/claude-x.*not in the container/);
    expect(sandboxAccountBlock('claude', 'work')).toBeUndefined();
    expect(sandboxAccountBlock('codex')).toBeUndefined();
  });
});
