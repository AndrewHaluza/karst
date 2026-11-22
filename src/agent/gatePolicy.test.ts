import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureAccounts, resetAccounts } from './accounts/registry.js';
import { claudeAttendedDeny, claudeGateDeny, gateCheckDeniedCommands, gitCommonDirRoots, gateDeniedCommands, gateProtectedPaths, opencodeGatePermission } from './gatePolicy.js';
import { PROCESS_WIDE_KILL_COMMANDS } from './processKillGuard.js';

describe('gatePolicy', () => {
  it('denies kills and build scripts', () => {
    const cmds = gateDeniedCommands();
    for (const k of PROCESS_WIDE_KILL_COMMANDS) expect(cmds).toContain(k);
    expect(cmds).toContain('npm rebuild*');
    expect(cmds).toContain('npm run build*');
  });

  it('protects home config incl. CLAUDE_CONFIG_DIR / CODEX_HOME overrides', () => {
    const paths = gateProtectedPaths({ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' }, '/h');
    expect(paths).toEqual(['/h/.claude.json', '/h/.claude/**', '/h/.codex/**', '/c/**', '/x/**']);
    expect(gateProtectedPaths({}, '/h')).toHaveLength(3);
  });

  it('claude deny uses absolute // path rules for Edit only (Edit covers Write; a Write path rule never matches)', () => {
    for (const deny of [claudeGateDeny({}, '/h'), claudeAttendedDeny({}, '/h')]) {
      expect(deny).toContain('Edit(//h/.claude.json)');
      expect(deny).toContain('Edit(//h/.codex/**)');
      expect(deny.some((r) => r.startsWith('Write('))).toBe(false);
    }
    expect(claudeGateDeny({}, '/h')).toContain('Bash(pkill *)');
  });

  it('allows cwd-relative edits, denies absolute and parent traversal, home config denied last', () => {
    const p = opencodeGatePermission('/wt', '/tmp', {}, '/h');
    expect(Object.keys(p.edit).slice(0, 4)).toEqual(['*', '/**', '..', '../**']);
    expect(p.edit['*']).toBe('allow');
    expect(p.edit['/**']).toBe('deny');
    expect(p.edit['..']).toBe('deny');
    expect(p.edit['../**']).toBe('deny');
    expect(p.edit['/wt/**']).toBe('allow');
    expect(p.edit['/tmp/**']).toBe('allow');
    expect(p.edit['/h/.claude.json']).toBe('deny');
    expect(p.bash['pkill *']).toBe('deny');
  });

  it('resolves paths as opencode2 does: only * and ? globs, last match wins', () => {
    // Emulates the opencode2 matcher: `*` -> `.*`, `?` -> `.`, anchored, last match wins.
    const decide = (rules: Record<string, string>, resource: string): string | undefined => {
      let verdict: string | undefined;
      for (const [glob, action] of Object.entries(rules)) {
        const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        if (new RegExp(`^${body}$`, 's').test(resource)) verdict = action;
      }
      return verdict;
    };
    const p = opencodeGatePermission('/wt', '/tmp', { CLAUDE_CONFIG_DIR: '/wt/.cfg' }, '/h');
    const cases: Array<[string, string]> = [
      ['src/a.ts', 'allow'],
      ['package.json', 'allow'],
      ['.', 'allow'],
      ['/wt/src/a.ts', 'allow'],
      ['/tmp/x', 'allow'],
      ['/etc/passwd', 'deny'],
      ['/other-repo/a.ts', 'deny'],
      ['..', 'deny'],
      ['../other/x', 'deny'],
      ['/h/.claude.json', 'deny'],
      ['/h/.codex/auth.json', 'deny'],
      ['/wt/.cfg/settings.json', 'deny'],
      ['.cfg/settings.json', 'deny'],
    ];
    for (const [resource, expected] of cases) expect(decide(p.edit, resource), resource).toBe(expected);
  });

  it('also allows the realpath of tmp when it differs (macOS /var vs /private/var)', () => {
    const root = mkdtempSync(join(tmpdir(), 'karst-tmp-root-'));
    try {
      const link = join(root, 'link');
      symlinkSync(root, link, 'dir');
      const p = opencodeGatePermission('/wt', link, {}, '/h');
      expect(p.edit[`${link}/**`]).toBe('allow');
      expect(p.edit[`${realpathSync(root)}/**`]).toBe('allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gate policy: worktree git + extra roots', () => {
  it('allows extra roots in the opencode edit map', () => {
    const p = opencodeGatePermission('/wt', '/tmp', {}, '/h', ['/extra']);
    expect(p.edit['/extra/**']).toBe('allow');
  });

  it('resolves a linked worktree to the shared .git dir; plain checkout gives none', () => {
    const root = mkdtempSync(join(tmpdir(), 'karst-gitroots-'));
    try {
      mkdirSync(join(root, 'main/.git/worktrees/w'), { recursive: true });
      mkdirSync(join(root, 'wt'));
      writeFileSync(join(root, 'wt/.git'), `gitdir: ${join(root, 'main/.git/worktrees/w')}\n`);
      expect(gitCommonDirRoots(join(root, 'wt'))).toEqual([join(root, 'main/.git')]);
      writeFileSync(join(root, 'main/.git/worktrees/w/commondir'), '../..\n');
      expect(gitCommonDirRoots(join(root, 'wt'))).toEqual([join(root, 'main/.git')]);
      expect(gitCommonDirRoots(join(root, 'main'))).toEqual([]);
      expect(gitCommonDirRoots(join(root, 'missing'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('reviewer policy', () => {
  it('adds the check deny and the declared gate scripts to the gate list', () => {
    const cmds = gateDeniedCommands('reviewer', ['lint:react', 'uat:host-probe']);
    expect(cmds).toEqual(expect.arrayContaining([...gateDeniedCommands('gate'), 'npm test*', 'npx vitest*', 'npm run lint:react*']));
    expect(cmds).not.toContain('npm run uat:host-probe*');
    expect(cmds).not.toContain('npm run uat:host*');
  });

  it('leaves the gate profile unchanged', () => {
    expect(gateDeniedCommands('gate')).not.toContain('npm test*');
    expect(claudeGateDeny({}, '/h')).not.toContain('Bash(npm test*)');
    expect(claudeGateDeny({}, '/h', 'reviewer', ['x'])).toEqual(expect.arrayContaining(['Bash(npm test*)', 'Bash(npm run x*)']));
  });

  it('emits the deny in the opencode permission map', () => {
    const p = opencodeGatePermission('/wt', '/tmp', {}, '/h', [], 'reviewer', ['x']);
    expect(p.bash['vitest*']).toBe('deny');
    expect(p.bash['npm run x*']).toBe('deny');
    expect(opencodeGatePermission('/wt', '/tmp', {}, '/h').bash['vitest*']).toBeUndefined();
  });

  it('gateCheckDeniedCommands de-duplicates', () => {
    expect(gateCheckDeniedCommands(['test', 'test']).filter((c) => c === 'npm run test*')).toHaveLength(1);
  });
});

describe('uat-tester policy', () => {
  it('carries the reviewer deny and keeps npm run uat:host* allowed', () => {
    const cmds = gateDeniedCommands('uat-tester', ['test:unit']);
    expect(cmds).toEqual(expect.arrayContaining(['npm test*', 'npx playwright*', 'npm run test:unit*']));
    expect(cmds).not.toContain('npm run uat:host*');
    expect(claudeGateDeny({}, '/h', 'uat-tester', ['x'])).toContain('Bash(npm run x*)');
    expect(opencodeGatePermission('/wt', '/tmp', {}, '/h', [], 'uat-tester', ['x']).bash['vitest*']).toBe('deny');
  });
});

describe('gateProtectedPaths accounts (AC-55)', () => {
  afterEach(() => resetAccounts());
  it('protects the folder of every stored account, not only the active one', () => {
    const acct = (dir: string) => ({ kind: 'subscription' as const, source: 'folder' as const, dir });
    configureAccounts({ claude: { active: 'a', list: { a: acct('/w/a'), b: acct('/w/b'), c: { ...acct(''), source: 'command' as const, command: 'x' } } } });
    const paths = gateProtectedPaths({}, '/h');
    expect(paths).toEqual(expect.arrayContaining(['/w/a/**', '/w/b/**']));
    expect(paths).not.toContain('/**');
  });
});
