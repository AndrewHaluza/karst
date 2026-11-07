import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveClaudeProjectsDir, transcriptPathFor } from '../claudeTranscriptWatch.js';
import { AntigravityAdapter } from '../antigravity.js';
import { ClaudeAdapter } from '../claude.js';
import { CodexAdapter } from '../codex.js';
import { OpencodeAdapter } from '../opencode.js';
import { Opencode2Adapter } from '../opencode2.js';
import { configureAccounts, configureRecordedAccountLookup, resetAccounts } from './registry.js';
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

const headlessAdapters = [
  ['claude', (s: never) => new ClaudeAdapter(s), 'CLAUDE_CONFIG_DIR'],
  ['codex', (s: never) => new CodexAdapter(s), 'CODEX_HOME'],
  ['opencode', (s: never) => new OpencodeAdapter(s), 'XDG_DATA_HOME'],
  ['antigravity', (s: never) => new AntigravityAdapter(s), 'ANTIGRAVITY_EXECUTABLE_DATA_DIR'],
] as const;

describe.each(headlessAdapters)('%s headless resume runs under the recorded account', (core, make, envVar) => {
  async function envOfRun(resume: string | undefined): Promise<Record<string, string | undefined>> {
    let seen: Record<string, string | undefined> = {};
    const spawn = (async (_c: string, _a: string[], _cwd: string, opts?: { isolationEnv?: Record<string, string> }) => {
      seen = { ...(opts?.isolationEnv ?? {}) };
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false };
    }) as never;
    await make(spawn).runHeadless({ prompt: 'p', cwd: '/wt', policy: 'gate', ...(resume ? { resume } : {}) } as never).catch(() => undefined);
    return seen;
  }
  it('uses the recorded account of the resumed session, not the active one', async () => {
    configureAccounts({ [core]: { active: 'a', list: { a: acct('/h/a'), b: acct('/h/b') } } });
    configureRecordedAccountLookup((c, id) => (c === core && id === 'sess-b' ? 'b' : undefined));
    try {
      expect((await envOfRun('sess-b'))[envVar]).toBe('/h/b');
      expect((await envOfRun(undefined))[envVar]).toBe('/h/a');
      expect((await envOfRun('sess-unknown'))[envVar]).toBe('/h/a');
    } finally {
      configureRecordedAccountLookup(undefined);
    }
  });
  it('pins the default account for a NULL record and fails for a deleted account', async () => {
    configureAccounts({ [core]: { active: 'a', list: { a: acct('/h/a') } } });
    configureRecordedAccountLookup((_c, id) => (id === 'old' ? null : id === 'gone' ? 'deleted' : undefined));
    try {
      expect((await envOfRun('old'))[envVar]).toBeUndefined();
      const spawn = (async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false })) as never;
      await expect(make(spawn).runHeadless({ prompt: 'p', cwd: '/wt', policy: 'gate', resume: 'gone' } as never)).rejects.toThrow(AccountNotFoundError);
    } finally {
      configureRecordedAccountLookup(undefined);
    }
  });
});

describe('claude resolveResume reads the recorded account folder', () => {
  it('finds the transcript under the recorded account, not the active one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resume-'));
    try {
      const wt = '/work/tree';
      const bDir = join(root, 'b');
      const file = transcriptPathFor(resolveClaudeProjectsDir({ CLAUDE_CONFIG_DIR: bDir } as NodeJS.ProcessEnv), wt, 'sess-b');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{}\n');
      configureAccounts({ claude: { active: 'a', list: { a: acct(join(root, 'a')), b: acct(bDir) } } });
      configureRecordedAccountLookup((_c, id) => (id === 'sess-b' ? 'b' : undefined));
      expect(await new ClaudeAdapter().resolveResume('sess-b', { cwd: wt })).toBe('sess-b');
      configureRecordedAccountLookup(undefined);
      expect(await new ClaudeAdapter().resolveResume('sess-b', { cwd: wt })).toBeUndefined();
    } finally {
      configureRecordedAccountLookup(undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
