import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { sshArgv, sshControlPath, sshDest, sshOptions } from './sshProcess.js';
import { remoteSh } from './sshQuote.js';

const remote: RemoteDef = {
  host: 'devbox.example.com',
  user: 'karst',
  port: 2222,
  keyPath: '~/.ssh/id_ed25519',
  mode: 'direct',
  remoteDir: '/srv/karst',
};

const CONTROL_DIR = '/tmp/karst-ssh-501/';

describe('sshDest', () => {
  it('is <user>@<host>', () => {
    expect(sshDest(remote)).toBe('karst@devbox.example.com');
  });
});

describe('sshOptions', () => {
  it('returns the hardened options in the exact A.2 order', () => {
    expect(sshOptions(remote, CONTROL_DIR)).toEqual([
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ForwardAgent=no',
      '-o', 'ForwardX11=no',
      '-o', 'ClearAllForwardings=yes',
      '-o', 'PermitLocalCommand=no',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPersist=600',
      '-o', `ControlPath=${CONTROL_DIR}%C`,
      '-p', '2222',
      '-i', '~/.ssh/id_ed25519',
      '-o', 'IdentitiesOnly=yes',
    ]);
  });

  it('defaults the port to 22 and omits -i without a keyPath', () => {
    const options = sshOptions({ host: 'h.example.com', user: 'u', mode: 'docker', remoteDir: '/srv/k' }, CONTROL_DIR);
    expect(options).not.toContain('-i');
    expect(options).not.toContain('IdentitiesOnly=yes');
    expect(options.slice(-2)).toEqual(['-p', '22']);
    expect(options).toContain('BatchMode=yes');
    expect(options).toContain('StrictHostKeyChecking=yes');
  });

  it('is options only: no destination, no --, no remote command', () => {
    const options = sshOptions(remote, CONTROL_DIR);
    expect(options).not.toContain('--');
    expect(options).not.toContain(sshDest(remote));
    expect(options.some((a) => a.includes('sh -c'))).toBe(false);
  });

  it('takes a control dir with or without a trailing slash', () => {
    expect(sshControlPath('/tmp/karst-ssh-501/')).toBe('/tmp/karst-ssh-501/%C');
    expect(sshControlPath('/tmp/karst-ssh-501')).toBe('/tmp/karst-ssh-501/%C');
    expect(sshOptions(remote, '/tmp/karst-ssh-501')).toContain('ControlPath=/tmp/karst-ssh-501/%C');
  });

  it('mux: false turns multiplexing off and keeps forwarding (tunnels, D823)', () => {
    const options = sshOptions(remote, CONTROL_DIR, { mux: false });
    expect(options).toContain('ControlMaster=no');
    expect(options).toContain('ControlPath=none');
    expect(options).not.toContain('ControlMaster=auto');
    expect(options).not.toContain(`ControlPath=${CONTROL_DIR}%C`);
    expect(options.join(' ')).not.toContain('ClearAllForwardings');
    expect(options).toContain('BatchMode=yes');
    expect(options).toContain('StrictHostKeyChecking=yes');
  });

  it('mux: true is the default form', () => {
    expect(sshOptions(remote, CONTROL_DIR, { mux: true })).toEqual(sshOptions(remote, CONTROL_DIR));
  });
});

describe('sshArgv', () => {
  it('puts the options first, then --, then the destination, then one remote command', () => {
    const options = sshOptions(remote, CONTROL_DIR);
    const argv = sshArgv(remote, CONTROL_DIR, 'echo hi');
    expect(argv.slice(0, options.length)).toEqual(options);
    expect(argv[options.length]).toBe('--');
    expect(argv[options.length + 1]).toBe('karst@devbox.example.com');
    expect(argv[options.length + 2]).toBe("sh -c 'echo hi'");
    expect(argv).toHaveLength(options.length + 3);
    expect(argv.at(-1)?.startsWith("sh -c '")).toBe(true);
    expect(argv.at(-1)).toBe(remoteSh('echo hi'));
  });

  it('puts caller flags after the hardened options and before --', () => {
    const options = sshOptions(remote, CONTROL_DIR);
    const argv = sshArgv(remote, CONTROL_DIR, 'true', { flags: ['-t', '-L', '8080:localhost:80'] });
    expect(argv.slice(0, options.length)).toEqual(options);
    expect(argv.slice(options.length, options.length + 3)).toEqual(['-t', '-L', '8080:localhost:80']);
    expect(argv[options.length + 3]).toBe('--');
    expect(argv.at(-2)).toBe('karst@devbox.example.com');
    expect(argv.at(-1)).toBe("sh -c 'true'");
  });

  it('every ssh option sits before the destination', () => {
    const argv = sshArgv(remote, CONTROL_DIR, 'echo hi', { flags: ['-t'] });
    const destIndex = argv.indexOf('karst@devbox.example.com');
    expect(destIndex).toBeGreaterThan(0);
    expect(argv[destIndex - 1]).toBe('--');
    for (const [i, arg] of argv.entries()) {
      if (i < destIndex - 1) expect(arg === '--', `-- only once: ${String(arg)}`).toBe(false);
      if (arg.startsWith('-o') || arg === '-p' || arg === '-i') expect(i).toBeLessThan(destIndex - 1);
    }
  });

  it('carries the mux: false form into the argv', () => {
    const argv = sshArgv(remote, CONTROL_DIR, 'true', { mux: false });
    expect(argv).toContain('ControlMaster=no');
    expect(argv).toContain('ControlPath=none');
    expect(argv).toContain('--');
  });

  it('quotes a hostile script as one inert argument', () => {
    const script = "echo 'x'; $(id)";
    const argv = sshArgv(remote, CONTROL_DIR, script);
    expect(argv.at(-1)).toBe(remoteSh(script));
    expect(argv.at(-1)).toBe(`sh -c 'echo '\\''x'\\''; $(id)'`);
  });
});
