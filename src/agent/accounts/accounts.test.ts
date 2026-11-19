import { describe, expect, it } from 'vitest';
import { parseShellAlias } from './aliasImport.js';
import { isDeniedSeedPath } from './copySeed.js';
import { AccountNotFoundError, activeAccountName, activeAccountSource, mergeAccountEnv, resolveAccountLaunch } from './resolve.js';
import { ACCOUNT_CORES, validateAccount, validateAccountName, validateAccountsConfig, type AccountsConfig } from './types.js';

const sub = (dir: string, extra: object = {}) => ({ kind: 'subscription', source: 'folder', dir, ...extra });

describe('slug and validation', () => {
  it('accepts safe slugs and rejects separators, dotdot, default', () => {
    expect(validateAccountName('work')).toBeNull();
    for (const bad of ['a/b', '..', 'a..b', 'default', '', 'A b', '-x']) expect(validateAccountName(bad)).not.toBeNull();
  });
  it('rejects unknown kind and source with a clear message', () => {
    expect(validateAccount('claude', { kind: 'apiKey', source: 'folder', dir: '/x' })).toMatch(/unknown account kind 'apiKey'/);
    expect(validateAccount('claude', { kind: 'subscription', source: 'cloud', dir: '/x' })).toMatch(/unknown account source 'cloud'/);
  });
  it('requires dir for claude, codex, antigravity', () => {
    for (const c of ['claude', 'codex', 'antigravity'] as const) expect(validateAccount(c, { kind: 'subscription', source: 'folder' })).toMatch(/dir/);
  });
  it('refuses a secret env key and shell syntax in command', () => {
    expect(validateAccount('claude', sub('/x', { env: { API_TOKEN: 'a' } }))).toMatch(/secret/);
    expect(validateAccount('claude', { kind: 'subscription', source: 'command', dir: '/x', command: 'a && b' })).toMatch(/no shell/);
  });
  it('reports an active account missing from the list', () => {
    expect(validateAccountsConfig({ claude: { active: 'w', list: {} } })).toEqual([expect.stringMatching(/not in the list/)]);
  });
});

describe('resolver', () => {
  const config: AccountsConfig = {
    claude: { active: 'w', list: { w: sub('/h/.claude-work') as never } },
    codex: { active: 'w', list: { w: sub('/h/.codex-w') as never } },
    opencode: { active: 'w', list: { w: sub('/h/od') as never } },
    opencode2: { active: 'w', list: { w: sub('/h/o2') as never } },
    antigravity: { active: 'w', list: { w: { ...sub('/h/agy'), source: 'command', command: '/bin/agy-w', args: ['--x'] } as never } },
  };
  it('default is a no-op for every core', () => {
    for (const core of ACCOUNT_CORES) {
      expect(resolveAccountLaunch({ config: {}, core, defaultBinary: 'bin' })).toEqual({ account: 'default', binary: 'bin', args: [], env: {} });
    }
  });
  it('sets each core home variable', () => {
    const r = (core: (typeof ACCOUNT_CORES)[number]) => resolveAccountLaunch({ config, core, defaultBinary: 'b' });
    expect(r('claude').env).toEqual({ CLAUDE_CONFIG_DIR: '/h/.claude-work' });
    expect(r('codex').env).toEqual({ CODEX_HOME: '/h/.codex-w' });
    expect(r('opencode').env).toEqual({ XDG_DATA_HOME: '/h/od' });
    expect(r('antigravity')).toMatchObject({ binary: '/bin/agy-w', args: ['--x'], env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: '/h/agy' } });
  });
  it('opencode2 gets an isolated XDG root and keeps the autoupdater switch', () => {
    const env = resolveAccountLaunch({ config, core: 'opencode2', defaultBinary: 'b' }).env;
    expect(env).toMatchObject({ XDG_DATA_HOME: '/h/o2/data', XDG_CONFIG_HOME: '/h/o2/config', DISABLE_AUTOUPDATER: '1' });
  });
  it('a recorded account wins over the active one; a deleted one throws, no fallback', () => {
    expect(resolveAccountLaunch({ config, core: 'claude', defaultBinary: 'b', account: 'default' }).env).toEqual({});
    expect(() => resolveAccountLaunch({ config, core: 'claude', defaultBinary: 'b', account: 'gone' })).toThrow(AccountNotFoundError);
  });
  it('karst-owned env wins over account env', () => {
    expect(mergeAccountEnv({ A: '1', KARST_DB: 'acct' }, { KARST_DB: 'karst' })).toEqual({ A: '1', KARST_DB: 'karst' });
  });
});

describe('alias import', () => {
  const base = { core: 'claude', name: 'claude-work', home: '/Users/u', defaultBinary: 'claude' } as const;
  it('imports the double-quoted $HOME form', () => {
    const r = parseShellAlias({ ...base, aliasText: `alias claude-work='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'` });
    expect(r).toEqual({ ok: true, account: { kind: 'subscription', source: 'folder', dir: '/Users/u/.claude-work', env: { CLAUDE_CONFIG_DIR: '/Users/u/.claude-work' } } });
  });
  it('imports the single-quoted and ~ forms; non-default binary becomes command', () => {
    const r = parseShellAlias({ ...base, aliasText: `claude-work=CLAUDE_CONFIG_DIR=~/.cw ~/bin/claude2 --flag` });
    expect(r).toMatchObject({ ok: true, account: { source: 'command', command: '/Users/u/bin/claude2', args: ['--flag'], dir: '/Users/u/.cw' } });
  });
  it.each(['a; b', 'a | b', 'a && b', 'x $(id)', 'x `id`', 'CLAUDE_CONFIG_DIR=$FOO claude'])('refuses %s', (body) => {
    const r = parseShellAlias({ ...base, aliasText: `alias claude-work='${body}'` });
    expect(r.ok).toBe(false);
  });
  it('refuses a secret-like env key', () => {
    const r = parseShellAlias({ ...base, aliasText: `alias claude-work='CLAUDE_CONFIG_DIR=/x ANTHROPIC_API_KEY=abc claude'` });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/secret/) });
    expect(JSON.stringify(r)).not.toContain('abc');
  });
  it('refuses when the alias sets no home variable', () => {
    expect(parseShellAlias({ ...base, aliasText: `alias claude-work='claude'` }).ok).toBe(false);
  });
});

describe('copy deny list', () => {
  it('denies credentials, history, caches, logs, locks', () => {
    for (const p of ['.credentials.json', 'auth.json', 'projects/x.jsonl', 'sessions/a', 'history.jsonl', 'skills/a/auth.json', 'cache/quota.json', 'x.log', 'a.lock', 'oauth-token']) {
      expect(isDeniedSeedPath(p)).toBe(true);
    }
    for (const p of ['settings.json', 'CLAUDE.md', 'skills/a/SKILL.md']) expect(isDeniedSeedPath(p)).toBe(false);
  });
});

describe('per-project active account (@arch:AC-55)', () => {
  const list = { w: sub('/h/w'), p: sub('/h/p') } as never;
  const config: AccountsConfig = {
    claude: { active: 'w', list },
    projects: { alpha: { claude: 'p' }, beta: { claude: 'default' } },
  };
  it('the project choice wins over the machine default', () => {
    expect(activeAccountName(config, 'claude', 'alpha')).toBe('p');
    expect(activeAccountSource(config, 'claude', 'alpha')).toBe('project');
  });
  it('a project with no choice uses the machine default, then default', () => {
    expect(activeAccountName(config, 'claude', 'other')).toBe('w');
    expect(activeAccountSource(config, 'claude', 'other')).toBe('machine');
    expect(activeAccountName(config, 'claude')).toBe('w');
    expect(activeAccountName({}, 'codex', 'alpha')).toBe('default');
  });
  it('an explicit default choice overrides a machine default', () => {
    expect(activeAccountName(config, 'claude', 'beta')).toBe('default');
  });
  it('a choice naming a deleted account resolves to the machine default and logs one debug line', () => {
    const stale: AccountsConfig = { claude: { active: 'w', list }, projects: { alpha: { claude: 'gone' } } };
    const lines: string[] = [];
    expect(activeAccountName(stale, 'claude', 'alpha', (m) => lines.push(m))).toBe('w');
    expect(activeAccountSource(stale, 'claude', 'alpha')).toBe('machine');
    expect(lines).toHaveLength(1);
  });
  it('resolveAccountLaunch uses the project choice for a new launch only', () => {
    expect(resolveAccountLaunch({ config, core: 'claude', defaultBinary: 'c', projectSlug: 'alpha' }).account).toBe('p');
    expect(resolveAccountLaunch({ config, core: 'claude', defaultBinary: 'c', projectSlug: 'alpha', account: 'w' }).account).toBe('w');
  });
  it('validates the projects map and accepts an old file without it', () => {
    expect(validateAccountsConfig({ claude: { active: 'default', list: {} } })).toEqual([]);
    expect(validateAccountsConfig(config)).toEqual([]);
    expect(validateAccountsConfig({ projects: { a: { nope: 'x' } } })).toEqual([expect.stringMatching(/unknown core 'nope'/)]);
    expect(validateAccountsConfig({ projects: { a: { claude: '../x' } } })).toEqual([expect.stringMatching(/projects\/a: claude:/)]);
    expect(validateAccountsConfig({ projects: [] })).toEqual([expect.stringMatching(/projects/)]);
    expect(validateAccountsConfig({ projects: { a: 'x' } })).toEqual([expect.stringMatching(/projects\/a/)]);
  });
});
