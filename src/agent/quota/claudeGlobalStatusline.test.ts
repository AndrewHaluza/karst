import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_SETTINGS_BACKUP_BASENAME,
  CLAUDE_STATUSLINE_WRAPPER_BASENAME,
} from './claudeStatusline.js';
import {
  applyClaudeGlobalStatusline,
  installClaudeGlobalStatusline,
  uninstallClaudeGlobalStatusline,
} from './claudeGlobalStatusline.js';

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-global-statusline-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(configDir: string, wrapperDir = join(makeDir(), 'wrapper')) {
  return installClaudeGlobalStatusline({ configDir, node: '/usr/bin/node', wrapperDir });
}
function readSettings(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
}
function statuslineCommand(configDir: string): string {
  return (readSettings(configDir).statusLine as { command: string }).command;
}

describe('installClaudeGlobalStatusline', () => {
  it('merges unknown settings keys and writes a one-time backup', () => {
    const configDir = makeDir();
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'] },
      statusLine: { type: 'command', command: 'bash ~/.claude/statusline.sh' },
    };
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(original, null, 2));

    const outcome = install(configDir);

    expect(outcome).toEqual({ installed: true, changed: true });
    const written = readSettings(configDir);
    expect(written.model).toBe('opus');
    expect(written.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(statuslineCommand(configDir)).toContain(CLAUDE_STATUSLINE_WRAPPER_BASENAME);
    expect(readFileSync(join(configDir, CLAUDE_SETTINGS_BACKUP_BASENAME), 'utf8')).toBe(
      JSON.stringify(original, null, 2),
    );
  });

  it('chains the operator command and restores it on uninstall (round-trip)', () => {
    const configDir = makeDir();
    const original = {
      statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' },
    };
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(original));

    install(configDir);
    expect(statuslineCommand(configDir)).toContain(`'bash ~/.claude/statusline-command.sh'`);

    expect(uninstallClaudeGlobalStatusline(configDir)).toEqual({ installed: false, changed: true });
    expect(readSettings(configDir)).toEqual(original);
    expect(existsSync(join(configDir, CLAUDE_SETTINGS_BACKUP_BASENAME))).toBe(false);
  });

  it('is idempotent: a second install writes nothing', () => {
    const configDir = makeDir();
    const wrapperDir = makeDir();
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'bash user.sh' } }),
    );
    install(configDir, wrapperDir);
    const path = join(configDir, 'settings.json');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(path, old, old);

    expect(install(configDir, wrapperDir)).toEqual({ installed: true, changed: false });
    expect(statSync(path).mtimeMs).toBe(old.getTime());
    expect(statuslineCommand(configDir)).toContain(`'bash user.sh'`);
    expect(readdirSync(configDir).sort()).toEqual(
      ['settings.json', CLAUDE_SETTINGS_BACKUP_BASENAME].sort(),
    );
  });

  it('never chains its own wrapper (no recursion)', () => {
    const configDir = makeDir();
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: '/usr/bin/node "/old/statusline.cjs" "/c/quota.json"',
        },
      }),
    );

    install(configDir);
    expect(statuslineCommand(configDir).split(CLAUDE_STATUSLINE_WRAPPER_BASENAME)).toHaveLength(2);
  });

  it('re-captures a command the operator changed while karst was installed', () => {
    const configDir = makeDir();
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'bash first.sh' } }),
    );
    install(configDir);

    // The operator swaps in a new statusline while the toggle is still ON.
    const changed = { model: 'opus', statusLine: { type: 'command', command: 'bash second.sh' } };
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(changed));

    install(configDir);
    expect(readFileSync(join(configDir, CLAUDE_SETTINGS_BACKUP_BASENAME), 'utf8')).toBe(
      JSON.stringify(changed),
    );
    uninstallClaudeGlobalStatusline(configDir);
    expect(statuslineCommand(configDir)).toBe('bash second.sh');
  });

  it('writes the wrapper outside the Claude config dir and only settings.json + backup inside it', () => {
    const configDir = makeDir();
    const wrapperDir = makeDir();
    install(configDir, wrapperDir);
    expect(existsSync(join(wrapperDir, CLAUDE_STATUSLINE_WRAPPER_BASENAME))).toBe(true);
    expect(readdirSync(configDir).sort()).toEqual(
      ['settings.json', CLAUDE_SETTINGS_BACKUP_BASENAME].sort(),
    );
  });

  it('keeps the cache path under the config dir', () => {
    const configDir = makeDir();
    install(configDir);
    expect(statuslineCommand(configDir)).toContain(join(configDir, 'cache', 'quota.json'));
  });

  it('refuses an unreadable settings.json instead of overwriting it', () => {
    const configDir = makeDir();
    mkdirSync(join(configDir, 'settings.json'));

    expect(install(configDir)).toEqual({
      installed: false,
      changed: false,
      refused: 'unreadable',
    });
    expect(statSync(join(configDir, 'settings.json')).isDirectory()).toBe(true);
  });

  it('refuses unparseable JSON instead of overwriting it', () => {
    const configDir = makeDir();
    writeFileSync(join(configDir, 'settings.json'), '{ not json');

    expect(install(configDir)).toEqual({
      installed: false,
      changed: false,
      refused: 'invalid-json',
    });
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toBe('{ not json');
  });
});

describe('uninstallClaudeGlobalStatusline', () => {
  it('does nothing when no karst entry is installed', () => {
    const configDir = makeDir();
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'bash user.sh' } }),
    );
    expect(uninstallClaudeGlobalStatusline(configDir)).toEqual({ installed: false, changed: false });
    expect(statuslineCommand(configDir)).toBe('bash user.sh');
  });

  it('never clobbers a command the operator changed while installed', () => {
    const configDir = makeDir();
    install(configDir);
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'bash changed.sh' } }),
    );

    expect(uninstallClaudeGlobalStatusline(configDir)).toEqual({ installed: false, changed: false });
    expect(statuslineCommand(configDir)).toBe('bash changed.sh');
    expect(existsSync(join(configDir, CLAUDE_SETTINGS_BACKUP_BASENAME))).toBe(false);
  });

  it('removes a karst entry that has no backup to restore', () => {
    const configDir = makeDir();
    install(configDir);
    rmSync(join(configDir, CLAUDE_SETTINGS_BACKUP_BASENAME));

    expect(uninstallClaudeGlobalStatusline(configDir)).toEqual({ installed: false, changed: true });
    expect(readSettings(configDir)).not.toHaveProperty('statusLine');
  });
});

describe('applyClaudeGlobalStatusline', () => {
  it('installs when ON and restores when OFF', () => {
    const configDir = makeDir();
    const wrapperDir = makeDir();
    applyClaudeGlobalStatusline({ enabled: true, configDir, wrapperDir, node: 'node' });
    expect(statuslineCommand(configDir)).toContain(CLAUDE_STATUSLINE_WRAPPER_BASENAME);

    applyClaudeGlobalStatusline({ enabled: false, configDir, wrapperDir, node: 'node' });
    expect(readSettings(configDir)).not.toHaveProperty('statusLine');
  });
});
