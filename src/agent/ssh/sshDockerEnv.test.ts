import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import {
  dockerEnvFileContent,
  removeRemoteServiceEnv,
  serviceEnvFilePath,
  writeRemoteDockerEnvFile,
} from './sshDockerEnv.js';

const REMOTE: RemoteDef = { host: 'fake.example.com', user: 'karst', mode: 'docker', remoteDir: '/srv/karst' };
const CONTROL = '/tmp/karst-ssh-0/';
const WS = '/srv/karst/karst-abcdef12-7-opencode';
const FILE = `${WS}/env/docker.env`;
const DIRS = [WS, `${WS}/bridge`, `${WS}/bridge/7`, `${WS}/bridge/7/results`, `${WS}/gates`, `${WS}/env`];

type Ssh = ReturnType<typeof fakeSshProcess>;

/** Decode the ONE quoting layer of `sshArgv` (`sh -c '<script>'`). */
function scriptOf(args: readonly string[]): string {
  return (args.at(-1) ?? '').replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");
}

function write(ssh: Ssh, over: Partial<Parameters<typeof writeRemoteDockerEnvFile>[0]> = {}) {
  return writeRemoteDockerEnvFile({
    ssh, remote: REMOTE, remoteName: 'devbox', controlDir: CONTROL,
    workspace: WS, file: FILE, dirs: DIRS, env: { A: '1' }, ...over,
  });
}

describe('dockerEnvFileContent', () => {
  it('writes literal KEY=VALUE lines, sorted, with no quotes, no export and no escapes', () => {
    expect(dockerEnvFileContent({ B: '2', A: '1' })).toBe('A=1\nB=2\n');
  });

  it('keeps single and double quotes exactly as they are (docker env-file has no quoting)', () => {
    const content = dockerEnvFileContent({ TOKEN: `it's "quoted" $HOME` });
    expect(content).toBe(`TOKEN=it's "quoted" $HOME\n`);
    expect(content).not.toContain('export');
  });

  it('writes a value holding an `=` as one value', () => {
    expect(dockerEnvFileContent({ DSN: 'postgres://u:p@h/db?x=1' })).toBe('DSN=postgres://u:p@h/db?x=1\n');
  });

  it('the empty record is the empty file', () => {
    expect(dockerEnvFileContent({})).toBe('');
  });

  it.each([
    ['a newline', 'A\ntail'],
    ['CRLF', 'A\r\ntail'],
    ['a trailing newline', 'A\n'],
  ])('refuses a value with %s: a second line would become another variable', (_label, value) => {
    expect(() => dockerEnvFileContent({ KEY: value })).toThrow('ssh docker: env value for KEY holds a newline');
  });

  it('refuses a name docker could not read', () => {
    expect(() => dockerEnvFileContent({ 'not-a-name': 'x' })).toThrow('ssh docker: invalid env name "not-a-name"');
  });
});

describe('writeRemoteDockerEnvFile', () => {
  it('sends the body over stdin, never on the argv', async () => {
    const ssh = fakeSshProcess();
    await write(ssh, { env: { SESSION_TOKEN: 'super-secret-value' } });
    expect(ssh.stdinCalls).toHaveLength(1);
    expect(ssh.stdinCalls[0]!.stdin.toString('utf8')).toBe('SESSION_TOKEN=super-secret-value\n');
    expect(ssh.stdinCalls[0]!.args.join(' ')).not.toContain('super-secret-value');
  });

  it('creates every dir 0700 with the symlink/owner guards, then writes 0600 under umask 077 via a temp file', async () => {
    const ssh = fakeSshProcess();
    await write(ssh);
    const script = scriptOf(ssh.stdinCalls[0]!.args);
    expect(script.startsWith('# karst-ssh-docker-env')).toBe(true);
    expect(script).toContain('umask 077');
    expect(script).toContain('[ -L "$1" ]');
    expect(script).toContain('[ -O "$1" ]');
    expect(script).toContain('chmod 700 "$1"');
    expect(script).toContain(`mkdir -p -m 700 "$1"`);
    for (const dir of DIRS) expect(script).toContain(`mkd '${dir}'`);
    expect(script).toContain(`f='${FILE}'`);
    expect(script).toContain('chmod 600 "$f.tmp"');
    expect(script).toContain('mv -f "$f.tmp" "$f"');
  });

  it('refuses a file outside the workspace before any ssh call', async () => {
    const ssh = fakeSshProcess();
    await expect(write(ssh, { file: '/etc/karst.env' })).rejects.toThrow('ssh docker: refusing env file "/etc/karst.env"');
    expect(ssh.stdinCalls).toHaveLength(0);
  });

  it('throws on a non-zero exit and on a transport drop (the launch then fails closed)', async () => {
    const refused = fakeSshProcess({ 'karst-ssh-docker-env': { code: 45, stderr: 'karst: refusing /x: it is a symlink\n' } });
    await expect(write(refused)).rejects.toThrow('ssh devbox: env file write failed (exit 45)');
    const dropped = fakeSshProcess({ 'karst-ssh-docker-env': { code: 255, transport: true, stderr: 'ssh: connect\n' } });
    await expect(write(dropped)).rejects.toThrow('ssh devbox: transport failed during env file write: ssh: connect');
  });
});

describe('serviceEnvFilePath', () => {
  it('is one plain segment under <ws>/env', () => {
    expect(serviceEnvFilePath(WS, 'web-2')).toBe(`${WS}/env/svc-web-2.env`);
  });

  it.each(['web/api', 'Web', '', 'a b', '../x'])('refuses the key %j', (key) => {
    expect(() => serviceEnvFilePath(WS, key)).toThrow(`ssh docker: invalid service env key "${key}"`);
  });
});

describe('removeRemoteServiceEnv', () => {
  it('removes exactly the service file with `rm -f --`', async () => {
    const ssh = fakeSshProcess();
    await removeRemoteServiceEnv(ssh, REMOTE, CONTROL, WS, 'web');
    expect(scriptOf(ssh.calls[0]!.args)).toContain(`rm -f -- '${WS}/env/svc-web.env'`);
  });

  it('refuses an unsafe key before any ssh call', async () => {
    const ssh = fakeSshProcess();
    await expect(removeRemoteServiceEnv(ssh, REMOTE, CONTROL, WS, '../etc/passwd')).rejects.toThrow('invalid service env key');
    expect(ssh.calls).toHaveLength(0);
  });
});
