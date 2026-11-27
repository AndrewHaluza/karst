import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { PipeEnd } from '../docker/dockerProcess.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import { dockerRemoteCommand, sshDockerArgv, sshDockerProcess } from './sshDockerProcess.js';

const REMOTE: RemoteDef = { host: 'fake.example.com', user: 'karst', mode: 'docker', remoteDir: '/srv/karst' };
const CONTROL = '/tmp/karst-ssh-0/';

/** The remote command: the LAST argv element (`sh -c '<script>'`). */
const remoteCmd = (args: readonly string[]): string => args.at(-1) ?? '';

/** Decode the one quoting layer `remoteSh` adds (`sh -c '<script>'`), so assertions read like the shell. */
function scriptOf(args: readonly string[]): string {
  return remoteCmd(args).replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");
}

type Ssh = ReturnType<typeof fakeSshProcess>;

function process(ssh: Ssh, remote: RemoteDef = REMOTE) {
  return sshDockerProcess(remote, ssh, { controlDir: CONTROL, sshBin: 'ssh' });
}

describe('sshDockerProcess: argv', () => {
  it('quotes every docker argument through sshQuote, so spaces, $, quotes and newlines stay inert', () => {
    const args = ['run', 'a b', '$HOME', "it's", 'line\nbreak', '; rm -rf /'];
    const script = scriptOf(sshDockerArgv(REMOTE, CONTROL, args));
    expect(script).toBe(`docker 'run' 'a b' '$HOME' 'it'\\''s' 'line\nbreak' '; rm -rf /'`);
  });

  it('an empty argument list is just `docker`', () => {
    expect(dockerRemoteCommand([])).toBe('docker');
  });

  it('every ssh invocation ends with ONE remote command under `sh -c` (run, pipe and the interactive form)', async () => {
    const ssh = fakeSshProcess();
    const proc = process(ssh);
    await proc.run('docker', ['ps']);
    await proc.pipe({ command: 'tar', args: ['-c', '.'] }, { command: 'docker', args: ['build', '-'] });
    const interactive = sshDockerArgv(REMOTE, CONTROL, ['run', '--interactive'], { flags: ['-t'] });
    expect(remoteCmd(ssh.calls[0]!.args).startsWith(`sh -c '`)).toBe(true);
    expect(remoteCmd(ssh.pipes[0]!.to.args).startsWith(`sh -c '`)).toBe(true);
    expect(remoteCmd(interactive).startsWith(`sh -c '`)).toBe(true);
    // The hardened options and `--` are still in front of the destination.
    expect(interactive.at(-3)).toBe('--');
    expect(interactive.at(-2)).toBe('karst@fake.example.com');
    expect(interactive).toContain('-t');
  });
});

describe('sshDockerProcess.run', () => {
  it('runs the docker client on the remote and passes its exit code, stdout and stderr through', async () => {
    const ssh = fakeSshProcess({ 'docker': { code: 3, stdout: 'out\n', stderr: 'err\n' } });
    await expect(process(ssh).run('docker', ['ps', '--all'])).resolves.toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' });
    expect(ssh.calls).toHaveLength(1);
    expect(scriptOf(ssh.calls[0]!.args)).toBe(`docker 'ps' '--all'`);
  });

  it('refuses a non-docker command: a host git or tar would act on THIS machine', async () => {
    const ssh = fakeSshProcess();
    await expect(process(ssh).run('git', ['status'])).rejects.toThrow('ssh docker: refusing non-docker command "git"');
    expect(ssh.calls).toHaveLength(0);
  });

  it('maps exit 255 to a transport failure: no stdout, prefixed stderr, transport true', async () => {
    const ssh = fakeSshProcess({ 'docker': { code: 255, stdout: 'docker output that must not escape', stderr: 'ssh: connect to host\n' } });
    await expect(process(ssh).run('docker', ['ps'])).resolves.toEqual({
      code: 255, stdout: '', stderr: 'ssh transport failed: ssh: connect to host', transport: true,
    });
  });

  it('maps an explicit transport result to the same shape, even with code 0', async () => {
    const ssh = fakeSshProcess({ 'docker': { code: 0, stdout: 'nope', stderr: '', transport: true } });
    await expect(process(ssh).run('docker', ['ps'])).resolves.toEqual({
      code: 255, stdout: '', stderr: 'ssh transport failed', transport: true,
    });
  });

  it('never treats 255 as a docker exit code (a probe would read it as a real answer)', async () => {
    const ssh = fakeSshProcess({ 'docker': { code: 255, stdout: 'No such volume\n' } });
    const out = await process(ssh).run('docker', ['volume', 'inspect', 'v']);
    expect(out.transport).toBe(true);
    expect(out.stdout).toBe('');
  });
});

describe('sshDockerProcess.pipe', () => {
  it('maps the docker end to ssh and leaves the host end (tar, git, node) exactly as given', async () => {
    const ssh = fakeSshProcess();
    const from: PipeEnd = { command: 'tar', args: ['-c', '-C', '/assets', '.'], env: { A: '1' } };
    const to: PipeEnd = { command: 'docker', args: ['build', '--tag', 'img', '-'], env: { B: '2' } };
    await expect(process(ssh).pipe(from, to)).resolves.toEqual({ fromCode: 0, toCode: 0 });
    const pipe = ssh.pipes[0]!;
    expect(pipe.from).toEqual(from);
    expect(pipe.to.command).toBe('ssh');
    expect(pipe.to.env).toEqual({ B: '2' });
    expect(scriptOf(pipe.to.args)).toBe(`docker 'build' '--tag' 'img' '-'`);
  });

  it('a docker END on the left also runs remotely (a container reads the stream)', async () => {
    const ssh = fakeSshProcess();
    await process(ssh).pipe({ command: 'docker', args: ['run', '-i', 'img', 'cat'] }, { command: 'tar', args: ['-x'] });
    expect(ssh.pipes[0]!.from.command).toBe('ssh');
    expect(ssh.pipes[0]!.to).toEqual({ command: 'tar', args: ['-x'] });
  });

  it('reports the pipe result unchanged', async () => {
    const ssh = fakeSshProcess({}, { fromCode: 2, toCode: 255 });
    await expect(process(ssh).pipe({ command: 'tar', args: [] }, { command: 'docker', args: ['build', '-'] })).resolves.toEqual({
      fromCode: 2, toCode: 255,
    });
  });
});

describe('sshDockerProcess defaults', () => {
  it('passes the caller ControlPath through (one multiplexed connection per window)', async () => {
    const ssh = fakeSshProcess();
    await process(ssh).run('docker', ['ps']);
    expect(ssh.calls[0]!.args).toContain(`ControlPath=${CONTROL}%C`);
  });

  it('defaults the ssh binary and the control dir (production constructors never pass them)', async () => {
    const ssh = fakeSshProcess();
    const proc = sshDockerProcess(REMOTE, ssh);
    await proc.run('docker', ['ps']);
    const argv = ssh.calls[0]!.args;
    expect(argv).toContain('-o');
    expect(argv.some((a) => a.startsWith('ControlPath='))).toBe(true);
    expect(argv.at(-2)).toBe('karst@fake.example.com');
  });

  it('does not read stdout as a process result on a transport drop (the caller sees empty stdout)', async () => {
    const ssh = fakeSshProcess({ 'docker': { code: 255, stdout: 'garbage', stderr: '' } });
    const out = await process(ssh).run('docker', ['image', 'inspect', 'x']);
    expect(out.code).toBe(255);
    expect(out.stdout).toBe('');
    expect(out.transport).toBe(true);
  });
});
