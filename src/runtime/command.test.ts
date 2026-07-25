import { describe, expect, it } from 'vitest';
import { prepareCommand, resolveOnPath, type ShimEnv } from './command.js';

const winEnv = (files: string[], pathVar = 'C:\\bin;C:\\Program Files\\nodejs'): ShimEnv => ({
  platform: 'win32',
  pathVar,
  pathExt: '.COM;.EXE;.BAT;.CMD',
  exists: (p) => files.includes(p),
});

const posixEnv: ShimEnv = {
  platform: 'darwin',
  pathVar: '/usr/bin:/usr/local/bin',
  pathExt: '',
  exists: () => true,
};

describe('resolveOnPath', () => {
  it('finds a .cmd shim that has no executable image', () => {
    const env = winEnv(['C:\\Program Files\\nodejs\\npm.cmd']);
    expect(resolveOnPath('npm', env)).toBe('C:\\Program Files\\nodejs\\npm.cmd');
  });

  it('prefers the earlier PATH entry over a later one', () => {
    const env = winEnv(['C:\\bin\\npm.cmd', 'C:\\Program Files\\nodejs\\npm.cmd']);
    expect(resolveOnPath('npm', env)).toBe('C:\\bin\\npm.cmd');
  });

  it('prefers the earlier PATHEXT extension within one directory', () => {
    const env = winEnv(['C:\\bin\\tool.cmd', 'C:\\bin\\tool.exe']);
    expect(resolveOnPath('tool', env)).toBe('C:\\bin\\tool.exe');
  });

  it('returns null when nothing on PATH matches', () => {
    expect(resolveOnPath('npm', winEnv([]))).toBeNull();
  });

  it('does not scan PATH for a command that already carries a path', () => {
    const env = winEnv(['C:\\other\\npm.cmd']);
    expect(resolveOnPath('C:\\tools\\npm.cmd', env)).toBeNull();
    expect(resolveOnPath('C:\\other\\npm.cmd', env)).toBe('C:\\other\\npm.cmd');
  });
});

describe('prepareCommand', () => {
  it('passes a command through untouched off Windows', () => {
    expect(prepareCommand('npm', ['test'], posixEnv)).toEqual({
      command: 'npm',
      args: ['test'],
    });
  });

  it('runs a Windows .cmd shim through cmd.exe', () => {
    // npm on Windows exists ONLY as npm.cmd: Node's spawn resolves executable
    // images, so the bare name is an ENOENT no matter what PATH says.
    const env = winEnv(['C:\\Program Files\\nodejs\\npm.cmd']);
    const spawned = prepareCommand('npm', ['test'], env);

    expect(spawned.command).toBe('cmd.exe');
    expect(spawned.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(spawned.windowsVerbatimArguments).toBe(true);
    expect(spawned.args[3]).toContain('npm.cmd');
    expect(spawned.args[3]).toContain('test');
  });

  it('escapes the spaces in a shim path instead of quoting it', () => {
    // cmd resolves the program name BEFORE it honours quotes, so a quoted path
    // makes it look for a program literally called `"C:\Program` — the default
    // npm install location is under Program Files, so this is the common case,
    // not an edge one. Caret-escaped spaces keep the path one token.
    const env = winEnv(['C:\\Program Files\\nodejs\\npm.cmd']);
    const payload = prepareCommand('npm', ['--version'], env).args[3]!;

    expect(payload).toContain('C:\\Program^ Files\\nodejs\\npm.cmd');
    expect(payload.startsWith('^"')).toBe(false);
  });

  it('neutralises cmd metacharacters in an argument', () => {
    // Gate args come from the repo's karst.yml, which karst does not author. With
    // a naive `shell: true` this string would run `calc` as a second command.
    const env = winEnv(['C:\\bin\\npm.cmd']);
    const payload = prepareCommand('npm', ['run', 'x && calc'], env).args[3]!;

    expect(payload).not.toMatch(/[^^]&&/);
    expect(payload).toContain('^&^&');
  });

  it('spawns a resolved executable image directly, with no shell', () => {
    const env = winEnv(['C:\\bin\\git.exe']);
    expect(prepareCommand('git', ['status'], env)).toEqual({
      command: 'C:\\bin\\git.exe',
      args: ['status'],
    });
  });

  it('passes an unresolvable command through so spawn reports its own ENOENT', () => {
    // Reporting "missing" is the caller's job (deps.ts turns ENOENT into install
    // guidance); inventing a cmd.exe wrapper here would only change the error.
    expect(prepareCommand('nope', ['--version'], winEnv([]))).toEqual({
      command: 'nope',
      args: ['--version'],
    });
  });
});
