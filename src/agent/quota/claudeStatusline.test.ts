import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_STATUSLINE_WRAPPER,
  CLAUDE_SETTINGS_BACKUP_BASENAME,
  buildStatuslineEntry,
  readChainedStatuslineCommand,
  writeStatuslineWrapper,
} from './claudeStatusline.js';

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-statusline-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildStatuslineEntry', () => {
  it('quotes the node, wrapper and cache paths and appends no chain when absent', () => {
    expect(
      buildStatuslineEntry({
        node: '/usr/bin/node',
        wrapperPath: '/cfg/claude/statusline.cjs',
        cachePath: '/home/u/.claude/cache/quota.json',
      }),
    ).toEqual({
      type: 'command',
      command:
        '"/usr/bin/node" "/cfg/claude/statusline.cjs" "/home/u/.claude/cache/quota.json"',
    });
  });

  it('carries the chained command as ONE single-quoted argv', () => {
    const entry = buildStatuslineEntry({
      node: 'node',
      wrapperPath: '/w/statusline.cjs',
      cachePath: '/c/quota.json',
      chainedCommand: 'bash ~/.claude/statusline-command.sh',
    });
    expect(entry.command.endsWith(`'bash ~/.claude/statusline-command.sh'`)).toBe(true);
  });

  it('escapes a single quote in the chained command so the shell keeps it literal', () => {
    const entry = buildStatuslineEntry({
      node: 'node',
      wrapperPath: '/w/statusline.cjs',
      cachePath: '/c/quota.json',
      chainedCommand: "echo 'hi'",
    });
    expect(entry.command.endsWith(`'echo '\\''hi'\\'''`)).toBe(true);
  });

  it('treats an empty chained command as no chain', () => {
    const entry = buildStatuslineEntry({
      node: 'node',
      wrapperPath: '/w/statusline.cjs',
      cachePath: '/c/quota.json',
      chainedCommand: '',
    });
    expect(entry.command).not.toContain("''");
  });
});

describe('readChainedStatuslineCommand', () => {
  it('returns undefined when settings.json is absent', () => {
    expect(readChainedStatuslineCommand(makeDir())).toBeUndefined();
  });

  it('returns undefined for unparseable or shapeless settings', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'settings.json'), '{ not json');
    expect(readChainedStatuslineCommand(dir)).toBeUndefined();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: {} }));
    expect(readChainedStatuslineCommand(dir)).toBeUndefined();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: { command: '' } }));
    expect(readChainedStatuslineCommand(dir)).toBeUndefined();
  });

  it("returns the operator's own statusline command", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' } }),
    );
    expect(readChainedStatuslineCommand(dir)).toBe('bash ~/.claude/statusline-command.sh');
  });

  it('SKIPS a command that already names the karst wrapper (no recursion)', () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'node "/x/claude/statusline.cjs" "/c/quota.json"' },
      }),
    );
    expect(readChainedStatuslineCommand(dir)).toBeUndefined();
  });

  it("recovers the operator's command from the global install's one-time backup", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'node "/x/claude/statusline.cjs" "/c/quota.json"' },
      }),
    );
    writeFileSync(
      join(dir, CLAUDE_SETTINGS_BACKUP_BASENAME),
      JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' } }),
    );
    expect(readChainedStatuslineCommand(dir)).toBe('bash ~/.claude/statusline-command.sh');
  });
});

describe('writeStatuslineWrapper', () => {
  it('writes the embedded wrapper and skips an identical rewrite', () => {
    const dir = makeDir();
    const path = writeStatuslineWrapper(dir);
    expect(readFileSync(path, 'utf8')).toBe(CLAUDE_STATUSLINE_WRAPPER);
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(path, old, old);
    writeStatuslineWrapper(dir);
    expect(statSync(path).mtimeMs).toBe(old.getTime());
  });

  it('creates the dir when missing', () => {
    const dir = join(makeDir(), 'nested', 'claude');
    const path = writeStatuslineWrapper(dir);
    expect(readFileSync(path, 'utf8')).toBe(CLAUDE_STATUSLINE_WRAPPER);
  });

  it('replaces a planted symlink without writing through it', () => {
    const root = makeDir();
    const target = join(root, 'host.txt');
    writeFileSync(target, 'host');
    const dir = join(root, 'claude');
    writeStatuslineWrapper(dir);
    rmSync(join(dir, 'statusline.cjs'));
    symlinkSync(target, join(dir, 'statusline.cjs'));
    writeStatuslineWrapper(dir);
    expect(readFileSync(target, 'utf8')).toBe('host');
    expect(lstatSync(join(dir, 'statusline.cjs')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'statusline.cjs'), 'utf8')).toBe(CLAUDE_STATUSLINE_WRAPPER);
  });
});
