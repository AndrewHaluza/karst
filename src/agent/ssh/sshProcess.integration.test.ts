import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { makeFakeSshBin, type FakeSshBin } from './fakeSshBin.js';
import { createNodeSshProcess, sshArgv, sshDest, sshOptions, type SshProcess } from './sshProcess.js';

/**
 * The seam against a real child process: the fake `ssh` from `fakeSshBin`
 * runs every remote command through a login shell in a temp "remote root",
 * the way sshd does. No network, no real host.
 */

const remote: RemoteDef = { host: 'fake.example.com', user: 'karst', port: 2222, mode: 'direct', remoteDir: '/srv/karst' };
const CONTROL_DIR = '/tmp/karst-ssh-0/';

let fake: FakeSshBin;
let proc: SshProcess;

beforeAll(async () => {
  fake = await makeFakeSshBin();
  proc = createNodeSshProcess({ sshBin: fake.ssh });
});

afterAll(async () => {
  await fake.cleanup();
});

function argv(script: string): string[] {
  return sshArgv(remote, CONTROL_DIR, script);
}

describe('SshProcess.run against the fake ssh', () => {
  it('runs the remote command through sh in the remote root', async () => {
    const run = await proc.run(argv('printf "hello\\n"; pwd'));
    expect(run.code).toBe(0);
    expect(run.transport).toBeUndefined();
    expect(run.stdout).toBe(`hello\n${fake.remoteRoot}\n`);
    expect(run.stdoutBuffer.toString('utf8')).toBe(run.stdout);
    expect(run.stderr).toBe('');
  });

  it('passes env to the child only', async () => {
    const run = await proc.run(argv('printf "%s" "$KARST_TEST_TOKEN"'), { env: { KARST_TEST_TOKEN: 'abc' } });
    expect(run.stdout).toBe('abc');
  });

  it('keeps stderr and code 255, and marks it a transport failure', async () => {
    const run = await proc.run(argv('printf "transport down\\n" >&2; exit 255'));
    expect(run.code).toBe(255);
    expect(run.stderr).toBe('transport down\n');
    expect(run.transport).toBe(true);
    expect(run.stdout).toBe('');
  });

  it('honours maxStdoutBytes', async () => {
    const run = await proc.run(argv("dd if=/dev/zero bs=1000 count=100 2>/dev/null | tr '\\0' a"), { maxStdoutBytes: 1000 });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('output exceeded 1000 bytes');
  });

  it('honours an abort signal (code 127, like the sbx seam)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const run = await proc.run(argv('echo hi'), { signal: ctrl.signal });
    expect(run.code).toBe(127);
    expect(run.stderr).toMatch(/abort/i);
  });
});

describe('SshProcess.runWithStdin against the fake ssh', () => {
  it('writes a Buffer to the remote stdin and returns raw stdout bytes', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const run = await proc.runWithStdin(argv('cat > stdin.bin; printf ok'), bytes);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('ok');
    expect(await readFile(join(fake.remoteRoot, 'stdin.bin'))).toEqual(bytes);
  });

  it('returns stdout as bytes, not a lossy string', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x41]);
    const run = await proc.runWithStdin(argv('cat'), bytes);
    expect(run.stdoutBuffer).toEqual(bytes);
    expect(run.stdout).not.toBe(bytes.toString('latin1'));
  });

  it('resolves with the exit code when the remote exits before it reads a Buffer (EPIPE)', async () => {
    // Larger than a pipe buffer, so the write is still pending when the remote exits.
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const run = await proc.runWithStdin(argv('exit 3'), bytes);
    expect(run.code).toBe(3);
  });

  it('streams a Readable to the remote stdin', async () => {
    const run = await proc.runWithStdin(argv('cat > readable.txt'), Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect(run.code).toBe(0);
    expect(await readFile(join(fake.remoteRoot, 'readable.txt'), 'utf8')).toBe('abcd');
  });
});

describe('SshProcess.pipe against the fake ssh', () => {
  it('streams a host command into the remote stdin without a JS string', async () => {
    const result = await proc.pipe(
      { command: process.execPath, args: ['-e', "process.stdout.write('piped-bundle')"] },
      { command: fake.ssh, args: argv('cat > piped.bundle; wc -c < piped.bundle') },
    );
    expect(result).toEqual({ fromCode: 0, toCode: 0 });
    expect(await readFile(join(fake.remoteRoot, 'piped.bundle'), 'utf8')).toBe('piped-bundle');
  });

  it('reports both exit codes', async () => {
    const result = await proc.pipe(
      { command: process.execPath, args: ['-e', 'process.exit(4)'] },
      { command: fake.ssh, args: argv('cat > /dev/null; exit 5') },
    );
    expect(result).toEqual({ fromCode: 4, toCode: 5 });
  });
});

describe('the login shell contract (Part A.4)', () => {
  it('the rejecting stub accepts remoteSh', async () => {
    const run = await proc.run(argv('echo wrapped'), { env: { KARST_FAKE_LOGIN_SHELL: fake.rejectLoginShell } });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('wrapped\n');
  });

  it('the rejecting stub rejects a bare script, so the fake cannot hide a missing sh', async () => {
    const bare = [...sshOptions(remote, CONTROL_DIR), '--', sshDest(remote), 'echo bare'];
    const run = await proc.run(bare, { env: { KARST_FAKE_LOGIN_SHELL: fake.rejectLoginShell } });
    expect(run.code).toBe(97);
    expect(run.stderr).toContain("does not start with 'sh -c '");
  });
});
