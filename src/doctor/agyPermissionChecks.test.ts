import { describe, expect, it } from 'vitest';
import { AGY_READ_ONLY_COMMANDS, checkAgyPermissions } from './agyPermissionChecks.js';

const ALL = AGY_READ_ONLY_COMMANDS.map((c) => `command(${c})`);

describe('checkAgyPermissions', () => {
  it('is ok when every read-only command is allowed', () => {
    const [c] = checkAgyPermissions({ settingsPath: '/s.json', allow: ALL });
    expect(c).toMatchObject({ id: 'tools.agy-permissions', area: 'tools', status: 'ok' });
  });

  it('accepts a wildcard rule that covers the command', () => {
    const [c] = checkAgyPermissions({
      settingsPath: '/s.json',
      allow: ['command(git *)', 'command(*)'],
    });
    expect(c?.status).toBe('ok');
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
