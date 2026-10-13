import { describe, expect, it } from 'vitest';
import { claudeGateDeny, gateDeniedCommands, gateProtectedPaths, opencodeGatePermission } from './gatePolicy.js';
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

  it('claude deny uses absolute // path rules for Edit and Write', () => {
    const deny = claudeGateDeny({}, '/h');
    expect(deny).toContain('Bash(pkill *)');
    expect(deny).toContain('Edit(//h/.claude.json)');
    expect(deny).toContain('Write(//h/.codex/**)');
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
