import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { bridgePaths } from '../bridge/bridgeDir.js';
import { dockerNames } from '../docker/dockerNames.js';
import { fakeSbxProcess } from '../sbx/fakeSbxProcess.js';
import { MARKER_EMIT } from '../hookBridge.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import { fakeTunnels, type FakeTunnels } from './fakeTunnels.js';
import {
  SSH_DOCKER_HOST_SERVICES_ERROR,
  createSshDockerSessionRunner,
  sshDockerMountRoot,
  type SshDockerRunnerOptions,
} from './sshDockerRunner.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'docker', remoteDir: '/srv/karst' };
const CONTROL = '/tmp/karst-ssh-0/';
const NAMES = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode', installId: 'install1' });
const NAMES2 = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode2', installId: 'install1' });
const WS = `/srv/karst/${NAMES.container}`;
/** `karst-<hash8>`: the prefix `dispose` requires. */
const PREFIX = NAMES.container.split('-').slice(0, 2).join('-');
const RUN_ID = 'abcd1234';
const CONTAINER = NAMES.container;
const SHA = 'a'.repeat(40);
const HOST = '/wt';
const BRANCH = 'feat/x';

type Ssh = ReturnType<typeof fakeSshProcess>;

/** Decode the ONE quoting layer of `sshArgv` (`sh -c '<script>'`). */
function sshScriptOf(args: readonly string[]): string {
  return (args.at(-1) ?? '').replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");
}

/** Split a decoded script into shell words (single quotes and `'\''` escapes understood). */
function tokens(script: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < script.length) {
    while (script[index] === ' ' || script[index] === '\n') index += 1;
    if (index >= script.length) break;
    let token = '';
    while (index < script.length && script[index] !== ' ' && script[index] !== '\n') {
      const char = script[index]!;
      if (char === "'") {
        index += 1;
        while (index < script.length && script[index] !== "'") {
          token += script[index]!;
          index += 1;
        }
        index += 1;
      } else if (char === '\\' && script[index + 1] === "'") {
        token += "'";
        index += 2;
      } else {
        token += char;
        index += 1;
      }
    }
    out.push(token);
  }
  return out;
}

const scriptsOf = (ssh: Ssh): string[] => ssh.calls.map((call) => sshScriptOf(call.args));

function parseEnvFile(body: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of body.split('\n')) {
    if (line === '') continue;
    const at = line.indexOf('=');
    env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

function makeRunner(over: Partial<SshDockerRunnerOptions> = {}) {
  return createSshDockerSessionRunner({
    ssh: fakeSshProcess(), sshBin: 'ssh', host: fakeSbxProcess(), remote: REMOTE, remoteName: 'devbox',
    controlDir: CONTROL, core: 'opencode', ticketId: 7, names: NAMES, user: { uid: 1000, gid: 1001 },
    hostWorktreePath: HOST, projectPrefix: PREFIX, newRunId: () => RUN_ID, tunnels: fakeTunnels().registry,
    ...over,
  });
}

const launchSpec = (over: Partial<Parameters<ReturnType<typeof makeRunner>['placeInteractive']>[0]> = {}) => ({
  ticketId: 7, hostWorktreePath: HOST, command: 'opencode', args: [] as string[],
  env: {
    OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask"},"cwd":"/wt","note":"SECRET-MARKER"}',
    KARST_LAUNCH_ID: 'L1',
    KARST_CLI: '/cli/main.js',
  },
  ...over,
});

describe('sshDockerMountRoot', () => {
  it('puts both mount sources on the remote host (a local path would mount nothing there)', () => {
    expect(sshDockerMountRoot('/srv/karst/', CONTAINER, 7)).toEqual({
      assetsDir: '/srv/karst/.karst-assets/r4',
      bridgeDir: `/srv/karst/${CONTAINER}/bridge/7`,
    });
  });

  it('refuses an invalid ticket id', () => {
    expect(() => sshDockerMountRoot('/srv/karst', CONTAINER, 0)).toThrow('ssh docker: invalid ticket id 0');
  });
});

describe('createSshDockerSessionRunner: identity', () => {
  it.each([
    ['opencode', NAMES],
    ['opencode2', NAMES2],
  ] as const)('%s: kind ssh, sandbox enforced, autonomous', (core, names) => {
    const runner = makeRunner({ core, names });
    expect(runner.kind).toBe('ssh');
    expect(runner.enforcesSandbox).toBe(true);
    expect(runner.autonomous).toBe(true);
    expect(runner.windowNeedsIdle).toBe(true);
  });
});

describe('createSshDockerSessionRunner: bridge mount, session env and argv', () => {
  it('writes docker.env over stdin: allow-all permissions, remote paths, the launch id, and no host-only or secret value', async () => {
    const ssh = fakeSshProcess();
    const runner = makeRunner({ ssh });
    await runner.prepareInteractive!(launchSpec());
    expect(ssh.stdinCalls).toHaveLength(1);
    const raw = ssh.stdinCalls[0]!.stdin.toString('utf8');
    const env = parseEnvFile(raw);
    expect(env.OPENCODE_CONFIG_DIR).toBe(`/karst-bridge/7/opencode/opencode-config`);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as { permission: { edit?: string }; cwd?: string; note?: string };
    expect(config.permission.edit).toBe('allow');
    expect(config.cwd).toBe('/work/repo');
    expect(config.note).toBe('SECRET-MARKER');
    expect(env.KARST_LAUNCH_ID).toBe('L1');
    expect(env.KARST_BRIDGE_DIR).toBe('/karst-bridge/7');
    // A host path (the CLI entry) never travels, and nothing rides the argv.
    expect(env.KARST_CLI).toBeUndefined();
    expect(ssh.stdinCalls[0]!.args.join(' ')).not.toContain('SECRET-MARKER');
    expect(raw).not.toContain('/cli/main.js');
    // The dirs were created (0700, guarded) before the file was written.
    expect(sshScriptOf(ssh.stdinCalls[0]!.args)).toContain(`mkd '${WS}/bridge/7'`);
  });

  it('mounts the REMOTE bridge dir at /karst-bridge/<ticketId>, passes --env-file and no by-name --env', () => {
    const runner = makeRunner();
    const placed = runner.placeInteractive!(launchSpec({ args: ['--flag'] }));
    expect(placed.cwd).toBe(HOST);
    expect(placed.shellPath).toBe('ssh');
    expect(placed.env).toEqual({});
    expect(placed.shellArgs).toContain('-t');
    expect(placed.shellArgs.at(-1)!.startsWith(`sh -c '`)).toBe(true);
    const docker = tokens(sshScriptOf(placed.shellArgs));
    expect(docker[0]).toBe('docker');
    expect(docker[1]).toBe('run');
    const mounted = docker.flatMap((arg, i) => (docker[i - 1] === '--mount' ? [arg] : []));
    expect(mounted).toContain(`type=bind,source=${WS}/bridge/7,target=/karst-bridge/7`);
    // No host worktree, auth file or temp path is ever a mount source.
    expect(mounted.some((m) => m.includes(`source=${HOST}`))).toBe(false);
    const envFiles = docker.flatMap((arg, i) => (docker[i - 1] === '--env-file' ? [arg] : []));
    expect(envFiles).toEqual([`${WS}/env/docker.env`]);
    const envFlags = docker.flatMap((arg, i) => (docker[i - 1] === '--env' ? [arg] : []));
    expect(envFlags.length).toBeGreaterThan(0);
    // ZERO by-name flags: every --env carries its value (the file is the one channel).
    expect(envFlags.every((flag) => flag.includes('='))).toBe(true);
    expect(docker).toContain('--workdir');
    expect(docker).not.toContain('--privileged');
    expect(placed.shellArgs.join('\n')).not.toContain('SECRET-MARKER');
    expect(placed.shellArgs.join('\n')).not.toContain('L1');
  });

  it('an opencode v1 account launch resolves XDG_DATA_HOME to the seeded store, not the v2 subtree', () => {
    const runner = makeRunner();
    const placed = runner.placeInteractive!(launchSpec({ env: { ...launchSpec().env, XDG_DATA_HOME: '/host/accounts/a/share' } }));
    const docker = tokens(sshScriptOf(placed.shellArgs));
    const envFlags = docker.flatMap((arg, i) => (docker[i - 1] === '--env' ? [arg] : []));
    // A folder/managed account carries the HOST data home; opencode v1 appends `/opencode`,
    // which is exactly where the seed wrote auth.json — never the v2 `xdg/data` subtree.
    expect(envFlags).toContain('XDG_DATA_HOME=/home/node/.local/share');
    expect(envFlags.join(' ')).not.toContain('/host/accounts/a');
  });

  it('abortLaunch stops the remote proxy a discarded launch started', async () => {
    const ssh = fakeSshProcess();
    const runner = makeRunner({ ssh });
    await runner.abortLaunch!();
    // A guard that timed out discards the runner: its proxy is the one object with egress.
    expect(scriptsOf(ssh).some((s) => s.includes(`'rm'`) && s.includes(`'--force'`) && s.includes('-proxy'))).toBe(true);
  });

  it('the bridge run dir ends in the ticket id, which is exactly what MARKER_EMIT reads', () => {
    const runner = makeRunner();
    const paths = bridgePaths('/tmp/karst-bridge-root', 7);
    expect(runner.bridgeRunDir!(paths)).toBe('/karst-bridge/7');
    // MARKER_EMIT takes the ticket from `<...>/<ticket>/events.ndjson`; the run
    // dir and the events file's parent must be the same numeric id.
    expect(basename(dirname(paths.eventsFile))).toBe('7');
    expect(MARKER_EMIT).toContain('path.basename(path.dirname(eventsPath))');
    expect(MARKER_EMIT).toContain('/^\\d+$/.test(ticketDir)');
  });
});

describe('createSshDockerSessionRunner: services', () => {
  it('writes a 0600 service env over stdin (no value on any argv), passes --env-file to docker exec, then removes it', async () => {
    const ssh = fakeSshProcess({ 'State.Running': { stdout: 'true\n' }, 'karst-ssh-gate-exit': { stdout: `${RUN_ID}:0\n` } });
    const gateCalls: { readonly command: string; readonly args: readonly string[] }[] = [];
    const runner = makeRunner({
      ssh,
      gateProcess: async (command, args) => {
        gateCalls.push({ command, args });
        return { kind: 'completed', exitCode: 0, output: '' };
      },
    });
    const file = await runner.writeServiceEnv!('web', { DATABASE_URL: "postgres://u:p'w@h/db", PORT: '3000' });
    expect(file).toBe(`${WS}/env/svc-web.env`);
    const stdin = ssh.stdinCalls.at(-1)!;
    expect(stdin.stdin.toString('utf8')).toBe(`DATABASE_URL=postgres://u:p'w@h/db\nPORT=3000\n`);
    expect(stdin.args.join(' ')).not.toContain('postgres://');
    expect(sshScriptOf(stdin.args)).toContain(`f='${WS}/env/svc-web.env'`);
    await expect(runner.writeServiceEnv!('web', { BAD: 'a\nb' })).rejects.toThrow('ssh docker: env value for BAD holds a newline');

    await runner.runGate!('npm', ['test'], HOST, { envFile: file });
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]!.command).toBe('ssh');
    const gateScript = sshScriptOf(gateCalls[0]!.args);
    expect(gateScript.startsWith('# karst-ssh-docker-gate')).toBe(true);
    const dockerLine = gateScript.split('\n').find((line) => line.startsWith('docker '));
    expect(dockerLine).toBeDefined();
    const docker = tokens(dockerLine!);
    expect(docker.slice(0, 2)).toEqual(['docker', 'exec']);
    expect(docker[docker.indexOf('--env-file') + 1]).toBe(file);
    expect(gateScript).not.toContain('postgres://');

    await runner.removeServiceEnv!('web');
    expect(scriptsOf(ssh).some((script) => script.includes(`rm -f -- '${WS}/env/svc-web.env'`))).toBe(true);
  });

  it('a shell command runs docker exec on the remote through ssh', async () => {
    const ssh = fakeSshProcess({ 'State.Running': { stdout: 'true\n' } });
    const runner = makeRunner({ ssh });
    const shell = await runner.shellCommand!({ hostWorktreePath: HOST, branch: BRANCH });
    expect(shell.ok).toBe(true);
    if (!shell.ok) return;
    expect(shell.cmd).toBe('ssh');
    expect(shell.args.at(-1)!.startsWith(`sh -c '`)).toBe(true);
    expect(tokens(sshScriptOf(shell.args)).slice(0, 2)).toEqual(['docker', 'exec']);
  });
});

describe('createSshDockerSessionRunner: clone ops use the D554 bundles', () => {
  function hostGit() {
    return fakeSbxProcess({
      [`git -C ${HOST} rev-parse --verify --quiet refs/karst/sandbox/${BRANCH}^{commit}`]: { stdout: `${SHA}\n` },
      [`git -C ${HOST} merge-base --is-ancestor HEAD ${SHA}`]: { code: 0 },
      [`git -C ${HOST} merge --ff-only ${SHA}`]: { code: 0 },
      [`git -C ${HOST} diff HEAD...${SHA}`]: { stdout: 'diff --git a/a b/a\n' },
    });
  }

  it('syncs, fetches, diffs and refreshes through the helper container; no git call ever reaches the ssh seam', async () => {
    const ssh = fakeSshProcess({
      '# karst-ssh-docker-clone-probe': { code: 128 },
      '# karst-ssh-docker-thin-bundle': { stdout: 'bundle' },
    });
    const host = hostGit();
    const runner = makeRunner({ ssh, host });
    const ticket = { hostWorktreePath: HOST, branch: BRANCH };
    await expect(runner.sync!(ticket)).resolves.toMatchObject({ ok: true });
    await expect(runner.fetchClone!(ticket)).resolves.toEqual({ ok: true });
    await expect(runner.diff!(ticket)).resolves.toEqual({ ok: true, diff: 'diff --git a/a b/a\n', ref: SHA });
    await expect(runner.refresh!(ticket)).resolves.toMatchObject({ ok: true });
    expect(host.calls.length).toBeGreaterThan(0);
    for (const call of host.calls) {
      expect(call.command).toBe('git');
      expect(call.args.slice(0, 2)).toEqual(['-C', HOST]);
    }
    // Every run on the ssh seam is a docker call (never a host git command).
    const scripts = scriptsOf(ssh);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script.startsWith('docker ')).toBe(true);
    // A git bundle crosses a PIPE, never a run.
    expect(ssh.pipes.some((pipe) => pipe.from.command === 'git')).toBe(true);
  });

  it('never bind-mounts a host path or temp dir into a remote container', async () => {
    const ssh = fakeSshProcess({
      '# karst-ssh-docker-clone-probe': { code: 128 },
      '# karst-ssh-docker-thin-bundle': { stdout: 'bundle' },
    });
    const runner = makeRunner({ ssh, host: hostGit() });
    const ticket = { hostWorktreePath: HOST, branch: BRANCH };
    await runner.sync!(ticket);
    await runner.refresh!(ticket);
    const everything = [...scriptsOf(ssh), ...ssh.pipes.map((pipe) => sshScriptOf(pipe.to.args))].join('\n');
    expect(everything).not.toContain(`source=${HOST}`);
    expect(everything).not.toMatch(/-v '?\//);
    // The one volume mount is the named repo volume at /work.
    expect(everything).toContain(`-v ${NAMES.repoVolume}:/work`);
  });
});

describe('createSshDockerSessionRunner: setup window', () => {
  it('recreates the proxy over ssh with karst.window-until, reads denied hosts, and restores the baseline', async () => {
    const ssh = fakeSshProcess({ 'logs': { stdout: 'DENY evil.example:443\n' } });
    const runner = makeRunner({ ssh });
    expect(runner.windowNeedsIdle).toBe(true);
    const win = await runner.setupWindow!(['registry.npmjs.org']);
    expect(win.ok).toBe(true);
    if (!win.ok) return;
    /** Every label ELEMENT (the inspect format names the labels too, so counting scripts would be wrong). */
    const labels = (prefix: string): string[] =>
      ssh.calls
        .flatMap((call) => tokens(sshScriptOf(call.args)))
        .filter((token) => token.startsWith(prefix));
    expect(labels('karst.window-until=')).toHaveLength(1);
    expect(labels('karst.allow=')).toHaveLength(1);
    // The proxy script path is the REMOTE assets dir, never the host bundle.
    expect(scriptsOf(ssh).some((script) => script.includes(`${WS.replace(CONTAINER, '.karst-assets/r4')}/allowlist-proxy.mjs`))).toBe(true);
    expect(await win.deniedHosts!()).toEqual(['evil.example']);
    await win.close();
    // Restored: the close recreates the BASELINE proxy (no window label).
    expect(labels('karst.window-until=')).toHaveLength(1);
    // No baseline host port ever reaches the remote proxy (D823).
    expect(scriptsOf(ssh).join('\n')).not.toContain('host-gateway');
    expect(scriptsOf(ssh).join('\n')).not.toContain('ALLOW_HOSTPORTS');
  });
});

describe('createSshDockerSessionRunner: dispose', () => {
  it('removes the docker objects AND the remote workspace directory', async () => {
    const ssh = fakeSshProcess();
    const runner = makeRunner({ ssh });
    const res = await runner.dispose!({ hostWorktreePath: HOST, branch: BRANCH });
    expect(res.ok).toBe(true);
    const commands = ssh.calls.map((call) => tokens(sshScriptOf(call.args)));
    expect(commands).toContainEqual(['docker', 'rm', '--force', CONTAINER, `${CONTAINER}-svc`]);
    expect(commands).toContainEqual(['docker', 'network', 'rm', NAMES.network]);
    expect(commands).toContainEqual(['docker', 'volume', 'rm', '--force', NAMES.repoVolume, NAMES.dataVolume]);
    expect(scriptsOf(ssh).some((script) => script.includes(`rm -rf -- '${WS}'`))).toBe(true);
  });

  it('refuses everything outside the project prefix, with zero docker calls', async () => {
    const ssh = fakeSshProcess();
    const runner = makeRunner({ ssh, projectPrefix: 'karst-ffffffff' });
    const res = await runner.dispose!({ hostWorktreePath: HOST, branch: BRANCH });
    expect(res.ok).toBe(false);
    expect(res.steps).toContainEqual(expect.objectContaining({ step: 'dispose guard', status: 'failed' }));
    // The guard runs FIRST (like the direct runner): a foreign name deletes nothing, not even
    // the same-named docker objects, and never an rm -rf.
    expect(ssh.calls).toHaveLength(0);
    expect(scriptsOf(ssh).some((script) => script.includes('rm -rf'))).toBe(false);
  });
});

describe('createSshDockerSessionRunner: host services and ports', () => {
  it('refuses declared baseline host ports: on a remote daemon host-gateway is the VM', async () => {
    const runner = makeRunner();
    await expect(runner.allowHostPorts!([5432])).resolves.toEqual({ ok: false, reason: SSH_DOCKER_HOST_SERVICES_ERROR });
    await expect(runner.allowHostPorts!([])).resolves.toEqual({ ok: true });
  });

  it('publishes on the remote and reports the port the relay forwards to', async () => {
    const ssh = fakeSshProcess();
    const runner = makeRunner({ ssh });
    await expect(runner.publishPort!({ hostPort: 4100, sandboxPort: 3000 })).resolves.toEqual({ ok: true, remotePort: 4100 });
    expect(scriptsOf(ssh).some((script) => script.includes(`${CONTAINER}-port-4100`))).toBe(true);
  });
});

describe('ssh docker: host -L tunnel over the remote relay (D823)', () => {
  const relayUp = (ssh: ReturnType<typeof fakeSshProcess>, port: number) =>
    scriptsOf(ssh).some((script) => script.includes(`${CONTAINER}-port-${String(port)}`));
  const flag = (argv: readonly string[], f: string): string => argv[argv.indexOf(f) + 1]!;

  it('opens <container>:L:<hostPort> to the remote 127.0.0.1 relay port after the relay', async () => {
    const t: FakeTunnels = fakeTunnels();
    const ssh = fakeSshProcess();
    const runner = makeRunner({ ssh, tunnels: t.registry });
    await expect(runner.publishPort!({ hostPort: 4100, sandboxPort: 3000 })).resolves.toEqual({ ok: true, remotePort: 4100 });
    expect(relayUp(ssh, 4100)).toBe(true);
    expect(t.registry.forSandbox(CONTAINER).map((h) => h.key)).toEqual([`${CONTAINER}:L:4100`]);
    expect(flag(t.spawned[0]!.argv, '-L')).toBe('127.0.0.1:4100:127.0.0.1:4100');
  });

  it('a failed tunnel removes the relay and returns the failure', async () => {
    const t = fakeTunnels({ connect: false, onSpawn: (c) => queueMicrotask(() => { c.stderr.emit('data', 'bind [127.0.0.1]:4100: Address already in use\n'); c.emit('exit', 255, null); }) });
    const ssh = fakeSshProcess();
    const runner = makeRunner({ ssh, tunnels: t.registry });
    await expect(runner.publishPort!({ hostPort: 4100, sandboxPort: 3000 })).resolves.toMatchObject({ ok: false, portTaken: true });
    const scripts = scriptsOf(ssh);
    expect(scripts.at(-1)).toContain(`${CONTAINER}-port-4100`);
    expect(scripts.at(-1)).toMatch(/rm/);
    expect(t.registry.forSandbox(CONTAINER)).toEqual([]);
  });

  it('a failed relay opens no tunnel', async () => {
    const t = fakeTunnels();
    const ssh = fakeSshProcess({ 'karst.ports=': { code: 125, stderr: 'boom' } });
    const out = await makeRunner({ ssh, tunnels: t.registry }).publishPort!({ hostPort: 4100, sandboxPort: 3000 });
    expect(out.ok).toBe(false);
    expect(t.spawned).toHaveLength(0);
  });

  it('unpublish closes the tunnel, then the relay; listPorts keeps only relays with a tunnel, with its state', async () => {
    const t = fakeTunnels();
    const ssh = fakeSshProcess({ '{{.Label': { stdout: '4100:3000\n4200:3001\n' } });
    const runner = makeRunner({ ssh, tunnels: t.registry });
    await runner.publishPort!({ hostPort: 4100, sandboxPort: 3000 });
    expect(await runner.listPorts!()).toEqual([{ hostPort: 4100, sandboxPort: 3000, state: 'up' }]);
    await t.registry.forSandbox(CONTAINER)[0]!.close();
    expect(await runner.listPorts!()).toEqual([{ hostPort: 4100, sandboxPort: 3000, state: 'down' }]);
    await runner.unpublishPort!({ hostPort: 4100, sandboxPort: 3000 });
    expect(t.spawned[0]!.kills).toBe(1);
    expect(await runner.listPorts!()).toEqual([]);
  });

  it('stopServices and dispose close the tunnels', async () => {
    const t = fakeTunnels();
    const runner = makeRunner({ tunnels: t.registry });
    await runner.publishPort!({ hostPort: 4100, sandboxPort: 3000 });
    await runner.stopServices!();
    expect(t.registry.forSandbox(CONTAINER)).toEqual([]);
    await runner.publishPort!({ hostPort: 4101, sandboxPort: 3000 });
    await runner.dispose!({ hostWorktreePath: HOST, branch: BRANCH });
    expect(t.registry.forSandbox(CONTAINER)).toEqual([]);
    expect(t.spawned.every((c) => c.kills === 1)).toBe(true);
  });
});

describe('ssh docker: host services stay off (D823)', () => {
  it('no env value on any argv (ssh, stdin, tunnel) and no hostPorts in any proxy script', async () => {
    const SECRET = 'svc-secret-value';
    const t = fakeTunnels();
    const ssh = fakeSshProcess({ 'State.Running': { stdout: 'true\n' } });
    const runner = makeRunner({ ssh, tunnels: t.registry });
    await runner.writeServiceEnv!('web', { DATABASE_URL: SECRET });
    await runner.publishPort!({ hostPort: 4100, sandboxPort: 3000 });
    expect(await runner.allowHostPorts!([5432])).toEqual({ ok: false, reason: SSH_DOCKER_HOST_SERVICES_ERROR });
    await runner.setupWindow!(['registry.npmjs.org']);
    const argvs = [...ssh.calls, ...ssh.stdinCalls].map((c) => c.args.join(' ')).concat(t.spawned.map((c) => c.argv.join(' ')));
    for (const a of argvs) expect(a).not.toContain(SECRET);
    for (const script of scriptsOf(ssh)) {
      expect(script).not.toContain('ALLOW_HOSTPORTS');
      expect(script).not.toContain('host-gateway');
    }
    expect(t.registry.list('devbox:R:')).toEqual([]);
  });
});
