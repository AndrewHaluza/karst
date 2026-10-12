import { describe, expect, it } from 'vitest';
import {
  AGY_READ_ONLY_COMMANDS,
  AGY_REQUIRED_COMMANDS,
  checkAgyPermissions,
} from './agyPermissionChecks.js';

const ALL = AGY_REQUIRED_COMMANDS.map((c) => `command(${c})`);

describe('checkAgyPermissions', () => {
  it('is ok when every required command is allowed', () => {
    const [c] = checkAgyPermissions({ settingsPath: '/s.json', allow: ALL });
    expect(c).toMatchObject({ id: 'tools.agy-permissions', area: 'tools', status: 'ok' });
  });

  it('is ok when one broad `command(git)` rule covers every git shape', () => {
    // agy matches a rule as a TOKEN PREFIX, so `command(git)` covers
    // `git diff …` and `git rev-parse …` in one rule.
    const nonGit = AGY_READ_ONLY_COMMANDS.filter((c) => !c.startsWith('git ')).map((c) => `command(${c})`);
    const [c] = checkAgyPermissions({ settingsPath: '/s.json', allow: ['command(git)', ...nonGit] });
    expect(c?.status).toBe('ok');
  });

  // The bug: `allows()` read a trailing `*` as a prefix wildcard, so a user
  // whose settings held `command(git *)` was told agy was ready while headless
  // runs auto-denied the mandated git checks. agy 1.3.3 treats `*` as a
  // LITERAL token — it matches nothing the lanes emit (@arch:AC-06).
  it('rejects a trailing `*` as a wildcard', () => {
    const [c] = checkAgyPermissions({
      settingsPath: '/s.json',
      allow: ['command(git *)', 'command(*)'],
    });
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('git diff');
    expect(c?.detail).toContain('git rev-parse');
  });

  // A `command(git rev-parse)` rule matches the required `git rev-parse`
  // shape by TOKEN PREFIX — it covers `git rev-parse --abbrev-ref HEAD` too.
  it('covers a required shape with its own token-prefix rule', () => {
    const [c] = checkAgyPermissions({
      settingsPath: '/s.json',
      allow: AGY_REQUIRED_COMMANDS.map((cmd) => (cmd === 'git rev-parse' ? 'command(git rev-parse)' : `command(${cmd})`)),
    });
    expect(c?.status).toBe('ok');
  });

  it('lists git rev-parse — the scope block mandates the plain checkout check', () => {
    // `agentScope.ts` tells every review/UAT agent to run
    // `git rev-parse --abbrev-ref HEAD`. Without this line the doctor would
    // report agy as ready while the mandated check is still auto-denied.
    expect(AGY_READ_ONLY_COMMANDS).toContain('git rev-parse');
    const [c] = checkAgyPermissions({
      settingsPath: '/s.json',
      allow: AGY_READ_ONLY_COMMANDS.filter((cmd) => cmd !== 'git rev-parse').map((cmd) => `command(${cmd})`),
    });
    expect(c?.detail).toContain('git rev-parse');
  });

  it('warns naming each missing command and the exact lines to add', () => {
    const [c] = checkAgyPermissions({
      settingsPath: '/s.json',
      allow: ['command(git diff)', 'command(ls)', 'unsandboxed(rg)'],
    });
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('rg');
    expect(c?.detail).not.toContain('git diff,');
    expect(c?.fix).toMatchObject({ tier: 'consented' });
    const fix = c?.fix;
    expect(fix?.tier === 'consented' && fix.command).toContain('"command(rg)"');
    expect(fix?.tier === 'consented' && fix.command).toContain('/s.json');
  });

  it('warns when the settings file is missing or unreadable', () => {
    const [c] = checkAgyPermissions({ settingsPath: '/s.json', allow: undefined });
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('/s.json');
  });
});
