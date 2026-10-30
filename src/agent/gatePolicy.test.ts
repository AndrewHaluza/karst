import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('opencode edit is deny-by-default, worktree+tmp allowed, home config denied last', () => {
    const p = opencodeGatePermission('/wt', '/tmp', {}, '/h');
    expect(Object.keys(p.edit).slice(0, 3)).toEqual(['*', '/wt/**', '/tmp/**']);
    expect(p.edit['*']).toBe('deny');
    expect(p.edit['/wt/**']).toBe('allow');
    expect(p.edit['/h/.claude.json']).toBe('deny');
    expect(p.bash['pkill *']).toBe('deny');
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
