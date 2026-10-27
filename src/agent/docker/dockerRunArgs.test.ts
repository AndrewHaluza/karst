import { describe, expect, it } from 'vitest';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { dockerNames } from './dockerNames.js';
import {
  bindMount,
  containerXdgEnv,
  envArgs,
  gateRunArgs,
  HARDENING,
  headlessExecArgs,
  headlessKillArgs,
  interactiveRunArgs,
  rewritePaths,
  serviceRunArgs,
  userArgs,
  volumeMounts,
} from './dockerRunArgs.js';

const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' });
const WT = '/Users/me/my repo/.karst/worktrees/t7';
const base = { names, core: 'opencode' as const, user: undefined, authFile: undefined, hostWorktreePath: WT, args: [WT], env: {} };

describe('interactiveRunArgs', () => {
  it('builds the exact argv: internal network, volumes, hardening, clone cwd', () => {
    expect(interactiveRunArgs(base)).toEqual([
      'run', '--interactive', '--tty', '--rm', '--init', '--name', names.container,
      '--network', names.network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=volume,source=${names.repoVolume},target=/work`,
      '--mount', `type=volume,source=${names.dataVolume},target=/home/node/.local/share/opencode`,
      ...envArgs({}), '--workdir', '/work/repo',
      OPENCODE_IMAGE, 'opencode1', '/work/repo',
    ]);
  });

  it('never mounts the docker socket, a host worktree or .git, never privileged', () => {
    const argv = interactiveRunArgs({ ...base, authFile: '/h/auth.json', user: { uid: 1001, gid: 1002 } }).join(' ');
    expect(argv).not.toMatch(/privileged|docker\.sock|type=bind,source=\/Users|\.git/);
  });

  it('mounts the v1 auth file read-only over the data volume', () => {
    const argv = interactiveRunArgs({ ...base, authFile: '/h d/auth.json' });
    expect(argv).toContain('type=bind,source=/h d/auth.json,target=/home/node/.local/share/opencode/auth.json,readonly');
  });

  it('runs as the host uid with a writable HOME on linux', () => {
    const argv = interactiveRunArgs({ ...base, user: { uid: 1001, gid: 1002 } });
    expect(argv.join(' ')).toContain('--user 1001:1002 --tmpfs /home/node:uid=1001,gid=1002,mode=0700');
  });

  it('launches opencode2 by its image name', () => {
    expect(interactiveRunArgs({ ...base, core: 'opencode2', args: ['--standalone'] }).slice(-2)).toEqual(['opencode2', '--standalone']);
  });
});

describe('envArgs', () => {
  it('passes adapter keys by name, remaps XDG onto the data volume, adds proxy and terminal keys', () => {
    expect(envArgs({ OPENCODE_CONFIG_CONTENT: '{"secret":1}', XDG_DATA_HOME: '/host/x/data' })).toEqual([
      '--env', 'OPENCODE_CONFIG_CONTENT',
      '--env', 'XDG_DATA_HOME=/home/node/.local/share/opencode/xdg/data',
      '--env', 'HTTPS_PROXY=http://karst-proxy:3128', '--env', 'HTTP_PROXY=http://karst-proxy:3128',
      '--env', 'https_proxy=http://karst-proxy:3128', '--env', 'http_proxy=http://karst-proxy:3128',
      '--env', 'NO_PROXY=localhost,127.0.0.1', '--env', 'no_proxy=localhost,127.0.0.1',
      '--env', 'TERM', '--env', 'COLORTERM',
    ]);
  });

  it('maps all four XDG dirs', () => {
    expect(containerXdgEnv()).toEqual({
      XDG_DATA_HOME: '/home/node/.local/share/opencode/xdg/data',
      XDG_CONFIG_HOME: '/home/node/.local/share/opencode/xdg/config',
      XDG_CACHE_HOME: '/home/node/.local/share/opencode/xdg/cache',
      XDG_STATE_HOME: '/home/node/.local/share/opencode/xdg/state',
    });
  });
});

describe('bindMount', () => {
  it('builds a bind value and refuses comma or newline paths', () => {
    expect(bindMount('/a b', '/t', true)).toBe('type=bind,source=/a b,target=/t,readonly');
    expect(bindMount('/a', '/t', false)).toBe('type=bind,source=/a,target=/t');
    expect(() => bindMount('/a,readonly=false', '/t', true)).toThrow(/unsafe bind path/);
    expect(() => bindMount('/a\nb', '/t', true)).toThrow(/unsafe bind path/);
  });
});

describe('rewritePaths', () => {
  it('rewrites the worktree path exactly and as a prefix, leaves others', () => {
    expect(rewritePaths([WT, `${WT}/src/a.ts`, `${WT}x`, '--model', 'm'], WT)).toEqual(
      ['/work/repo', '/work/repo/src/a.ts', `${WT}x`, '--model', 'm'],
    );
  });
  it('accepts a worktree path with a trailing slash', () => {
    expect(rewritePaths(['/w/a/b'], '/w/a/')).toEqual(['/work/repo/b']);
  });
});

describe('userArgs / volumeMounts', () => {
  it('is empty off linux', () => {
    expect(userArgs(undefined)).toEqual([]);
  });
  it('can mount the clone read-only', () => {
    expect(volumeMounts(names, { repoReadonly: true })[1]).toBe(`type=volume,source=${names.repoVolume},target=/work,readonly`);
  });
});

describe('headless exec', () => {
  it('execs through the fixed pid script with the command as argv', () => {
    expect(headlessExecArgs('c', 'r1', 'opencode1', ['run', '--', 'a b; rm -rf /'])).toEqual([
      'exec', '--interactive', '--workdir', '/work/repo', 'c',
      'sh', '-c', 'echo $$ > "/tmp/karst-run-$1.pid"; shift; exec "$@"', 'karst-run', 'r1',
      'opencode1', 'run', '--', 'a b; rm -rf /',
    ]);
  });
  it('kills by the recorded pid', () => {
    expect(headlessKillArgs('c', 'r1')).toEqual(['exec', 'c', 'sh', '-c', 'f="/tmp/karst-run-$1.pid"; [ -f "$f" ] && kill -KILL "$(cat "$f")" 2>/dev/null; rm -f "$f"', 'karst-kill', 'r1']);
  });
  it('refuses an unsafe run id', () => {
    expect(() => headlessExecArgs('c', '../x', 'a', [])).toThrow(/unsafe run id/);
    expect(() => headlessKillArgs('c', '')).toThrow(/unsafe run id/);
  });
});

describe('reaping init (zombies)', () => {
  it('every container that hosts repo processes runs docker --init', () => {
    // Without tini as PID 1 a killed tree's last descendant becomes a ZOMBIE
    // under PID 1 and `kill(pid, 0)` answers "alive" forever, so killTree's
    // "is it gone?" contract — and the repo's own process-tree suites — read a
    // corpse as a survivor.
    expect(interactiveRunArgs(base)).toContain('--init');
    expect(gateRunArgs(names, undefined, 'karst-g', 'npm', ['test'], {})).toContain('--init');
    expect(serviceRunArgs(names, undefined)).toContain('--init');
  });

  it('stays out of HARDENING, so the throwaway git/chown one-shots stay lean', () => {
    // dockerClone's one-shots only run git; they never host a process tree.
    expect(HARDENING).not.toContain('--init');
  });
});

describe('interactiveRunArgs bridge mount', () => {
  it('adds exactly one rw bind for the bridge dir at /karst-bridge/<id>', () => {
    const plain = interactiveRunArgs(base);
    const withBridge = interactiveRunArgs({ ...base, ticketId: 7, bridgeDir: '/g/events/7' });
    expect(withBridge).toContain('type=bind,source=/g/events/7,target=/karst-bridge/7');
    expect(withBridge.join(' ')).not.toContain('readonly,target=/karst-bridge');
    expect(withBridge.length).toBe(plain.length + 2);
  });
  it('throws when bridgeDir is set without ticketId (programming error)', () => {
    expect(() => interactiveRunArgs({ ...base, bridgeDir: '/g/events/7' })).toThrow('karst: a bridge mount needs a ticketId');
  });
  it('omits the bridge mount without bridgeDir', () => {
    expect(interactiveRunArgs(base).join(' ')).not.toContain('karst-bridge');
  });
  it('mounts <bridgeDir>/antigravity/gemini at /home/node/.gemini for antigravity core when bridgeDir is set', () => {
    const withBridge = interactiveRunArgs({ ...base, core: 'antigravity', ticketId: 7, bridgeDir: '/g/events/7' });
    expect(withBridge).toContain('type=bind,source=/g/events/7/antigravity/gemini,target=/home/node/.gemini');
    expect(withBridge.join(' ')).not.toContain('readonly,target=/home/node/.gemini');
  });
  it('mounts <bridgeDir>/antigravity/gemini at /home/node/.gemini for agy core when bridgeDir is set', () => {
    const withBridge = interactiveRunArgs({ ...base, core: 'agy', ticketId: 7, bridgeDir: '/g/events/7' });
    expect(withBridge).toContain('type=bind,source=/g/events/7/antigravity/gemini,target=/home/node/.gemini');
  });
  it('does not mount /home/node/.gemini for opencode even when bridgeDir is set', () => {
    const withBridge = interactiveRunArgs({ ...base, core: 'opencode', ticketId: 7, bridgeDir: '/g/events/7' });
    expect(withBridge.join(' ')).not.toContain('/home/node/.gemini');
  });
});

describe('memory flags', () => {
  const memory = { interactiveMemory: '2g', interactiveReservation: '1g', gateMemory: '3g', gateReservation: '1536m' };
  const names = dockerNames({ projectRoot: '/p', ticketId: 1, core: 'opencode' });
  const pair = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

  it('interactive run emits the interactive limit and reservation', () => {
    const argv = interactiveRunArgs({ ...base, memory });
    expect(pair(argv, '--memory')).toBe('2g');
    expect(pair(argv, '--memory-reservation')).toBe('1g');
  });

  it('gate run emits the gate limit and reservation', () => {
    const argv = gateRunArgs(names, undefined, 'run', 'npm', ['test'], {}, memory);
    expect(pair(argv, '--memory')).toBe('3g');
    expect(pair(argv, '--memory-reservation')).toBe('1536m');
  });

  it('adds no memory flag without limits', () => {
    expect(interactiveRunArgs(base)).not.toContain('--memory');
    expect(gateRunArgs(names, undefined, 'run', 'npm', [], {})).not.toContain('--memory-reservation');
  });
});
