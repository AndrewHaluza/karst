import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { GateProcessRunner, ProcessOutcome } from '../../workflow/gates/run.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import { sshDockerGateProcess, sshDockerGateScript } from './sshDockerGate.js';

const REMOTE: RemoteDef = { host: 'fake.example.com', user: 'karst', mode: 'docker', remoteDir: '/srv/karst' };
const CONTROL = '/tmp/karst-ssh-0/';
const WS = '/srv/karst/karst-abcdef12-7-opencode';
const RUN_ID = 'abcd1234';
const EXIT_READ = 'karst-ssh-gate-exit';
const CONTAINER = 'karst-abcdef12-7-opencode';
const DOCKER_EXEC = ['exec', '--interactive', '--workdir', '/work/repo', CONTAINER, 'sh', '-c', 'npm test'];

type Ssh = ReturnType<typeof fakeSshProcess>;

/** Decode the ONE quoting layer of `sshArgv` (`sh -c '<script>'`). */
function scriptOf(args: readonly string[]): string {
  return (args.at(-1) ?? '').replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");
}

function makeGate(ssh: Ssh, over: { readonly gateProcess?: GateProcessRunner; readonly newRunId?: () => string } = {}) {
  return sshDockerGateProcess({
    ssh, sshBin: 'ssh', remote: REMOTE, remoteName: 'devbox', controlDir: CONTROL,
    workspace: WS, hostWorktreePath: '/wt',
    newRunId: over.newRunId ?? (() => RUN_ID),
    gateProcess: over.gateProcess ?? (async (): Promise<ProcessOutcome> => ({ kind: 'completed', exitCode: 0, output: '' })),
  });
}

type Recorded = { readonly command: string; readonly args: readonly string[] };

describe('sshDockerGateProcess', () => {
  it('a >1 MiB gate that exits 255 reads 255 from <ws>/gates/<runId>.exit, never from the output head', async () => {
    const ssh = fakeSshProcess({ [EXIT_READ]: { stdout: `${RUN_ID}:255\n` } });
    const noise = 'x'.repeat(2 * 1024 * 1024);
    const recorded: Recorded[] = [];
    const gateProcess: GateProcessRunner = async (command, args, _cwd, opts) => {
      recorded.push({ command, args });
      opts?.onOutput?.({ stream: 'stdout', text: noise });
      opts?.onOutput?.({ stream: 'stderr', text: noise });
      return { kind: 'completed', exitCode: 255, output: noise.slice(0, 4000) };
    };
    const outcome = await makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt');
    expect(outcome).toMatchObject({ kind: 'completed', exitCode: 255 });
    // The exit file is the only record that survived the truncation.
    expect(ssh.calls).toHaveLength(1);
    expect(scriptOf(ssh.calls[0]!.args)).toContain('# karst-ssh-gate-exit');
    expect(ssh.calls[0]!.opts?.maxStdoutBytes).toBe(4 * 1024);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.command).toBe('ssh');
  });

  it('runs the docker argv on the remote and records the exit OUTSIDE the container (no gates bind mount)', async () => {
    const ssh = fakeSshProcess({ [EXIT_READ]: { stdout: `${RUN_ID}:0\n` } });
    const recorded: Recorded[] = [];
    const gateProcess: GateProcessRunner = async (command, args) => {
      recorded.push({ command, args });
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    await expect(makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt')).resolves.toMatchObject({
      kind: 'completed', exitCode: 0,
    });
    const script = scriptOf(recorded[0]!.args);
    expect(script.startsWith('# karst-ssh-docker-gate')).toBe(true);
    expect(script).toContain(`mkdir -p -m 700 '${WS}/gates'`);
    expect(script).toContain(`docker 'exec' '--interactive' '--workdir' '/work/repo' '${CONTAINER}'`);
    expect(script).toContain(`'${WS}/gates/${RUN_ID}.exit'`);
    expect(script).toContain('KARST_GATE_EXIT=');
    expect(script).toContain('exit $rc');
    // The gate dir is a HOST-side path: it is never mounted into the container.
    expect(script).not.toContain('--mount');
    expect(script).not.toContain(`${WS}/gates:`);
  });

  it('falls back to the LAST stderr marker when the exit file is gone, even after >1 MiB of stderr', async () => {
    const ssh = fakeSshProcess({ [EXIT_READ]: { code: 3 } });
    const noise = 'y'.repeat(2 * 1024 * 1024);
    const gateProcess: GateProcessRunner = async (_command, _args, _cwd, opts) => {
      opts?.onOutput?.({ stream: 'stderr', text: noise });
      opts?.onOutput?.({ stream: 'stderr', text: `\nKARST_GATE_EXIT=${RUN_ID}:3\n` });
      return { kind: 'completed', exitCode: 3, output: noise.slice(0, 2000) };
    };
    await expect(makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt')).resolves.toMatchObject({
      kind: 'completed', exitCode: 3,
    });
  });

  it('a marker of ANOTHER run id is ignored (a late line from a previous gate is not this verdict)', async () => {
    const ssh = fakeSshProcess({ [EXIT_READ]: { code: 3 } });
    const gateProcess: GateProcessRunner = async (_command, _args, _cwd, opts) => {
      opts?.onOutput?.({ stream: 'stderr', text: `\nKARST_GATE_EXIT=deadbeef:0\n` });
      return { kind: 'completed', exitCode: 1, output: '' };
    };
    await expect(makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt')).resolves.toMatchObject({ kind: 'spawnFailed' });
  });

  it('exit 255 with neither an exit file nor a marker is a transport failure: spawnFailed, no verdict', async () => {
    const ssh = fakeSshProcess({ [EXIT_READ]: { code: 3 } });
    const gateProcess: GateProcessRunner = async (): Promise<ProcessOutcome> => ({ kind: 'completed', exitCode: 255, output: 'Connection closed\n' });
    const outcome = await makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt');
    expect(outcome.kind).toBe('spawnFailed');
    if (outcome.kind === 'spawnFailed') expect(outcome.message).toContain('ssh transport failed');
  });

  it('a record the local exit contradicts is no verdict (confirmRecord)', async () => {
    const ssh = fakeSshProcess({ [EXIT_READ]: { stdout: `${RUN_ID}:0\n` } });
    const gateProcess: GateProcessRunner = async (): Promise<ProcessOutcome> => ({ kind: 'completed', exitCode: 1, output: '' });
    const outcome = await makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt');
    expect(outcome.kind).toBe('spawnFailed');
    if (outcome.kind === 'spawnFailed') expect(outcome.message).toContain('the gate record says 0, but the gate wrapper exited 1');
  });

  it('an unreadable exit file (transport) still uses the stderr marker', async () => {
    const ssh = fakeSshProcess({ [EXIT_READ]: { code: 255, transport: true } });
    const gateProcess: GateProcessRunner = async (_command, _args, _cwd, opts) => {
      opts?.onOutput?.({ stream: 'stderr', text: `\nKARST_GATE_EXIT=${RUN_ID}:7\n` });
      return { kind: 'completed', exitCode: 7, output: '' };
    };
    await expect(makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt')).resolves.toMatchObject({
      kind: 'completed', exitCode: 7,
    });
  });

  it('a transport-flagged read is never trusted, even when it carries code 0 and a record', async () => {
    const ssh = fakeSshProcess({ [EXIT_READ]: { code: 0, transport: true, stdout: `${RUN_ID}:0\n` } });
    const gateProcess: GateProcessRunner = async (_command, _args, _cwd, opts) => {
      opts?.onOutput?.({ stream: 'stderr', text: `\nKARST_GATE_EXIT=${RUN_ID}:4\n` });
      return { kind: 'completed', exitCode: 4, output: '' };
    };
    // The exit file's `0` cannot confirm the local 4; the marker can.
    await expect(makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt')).resolves.toMatchObject({
      kind: 'completed', exitCode: 4,
    });
  });

  it('returns a timeout and an abort as they are: createDockerSessionRunner killed the container already', async () => {
    const ssh = fakeSshProcess();
    const timedOut: ProcessOutcome = { kind: 'timedOut', output: 'timeout' };
    const gateProcess: GateProcessRunner = async () => timedOut;
    await expect(makeGate(ssh, { gateProcess })('docker', DOCKER_EXEC, '/wt')).resolves.toEqual(timedOut);
    const aborted: ProcessOutcome = { kind: 'aborted', output: 'stopped' };
    await expect(makeGate(ssh, { gateProcess: async () => aborted })('docker', DOCKER_EXEC, '/wt')).resolves.toEqual(aborted);
    // No exit-file read: there is no verdict to collect.
    expect(ssh.calls).toHaveLength(0);
  });

  it('refuses a non-docker command before spawning anything', async () => {
    const ssh = fakeSshProcess();
    const recorded: Recorded[] = [];
    const outcome = await makeGate(ssh, {
      gateProcess: async (command, args) => {
        recorded.push({ command, args });
        return { kind: 'completed', exitCode: 0, output: '' };
      },
    })('git', ['status'], '/wt');
    expect(outcome).toMatchObject({ kind: 'spawnFailed' });
    if (outcome.kind === 'spawnFailed') expect(outcome.message).toBe('ssh docker gate: refusing non-docker command "git"');
    expect(recorded).toHaveLength(0);
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('sshDockerGateScript', () => {
  it('keeps the wrapper outside the container and always writes both records', () => {
    const script = sshDockerGateScript(WS, RUN_ID, ['exec', CONTAINER, 'sh', '-c', 'true']);
    expect(script.split('\n')[0]).toBe('# karst-ssh-docker-gate');
    expect(script).toContain(`mkdir -p -m 700 '${WS}/gates'`);
    expect(script).toContain(`docker 'exec' '${CONTAINER}' 'sh' '-c' 'true'`);
    expect(script).toContain(`printf '%s:%s\\n' '${RUN_ID}' "$rc" > '${WS}/gates/${RUN_ID}.exit'`);
    expect(script).toContain(`printf '\\nKARST_GATE_EXIT=%s:%s\\n' '${RUN_ID}' "$rc" >&2`);
    expect(script.trimEnd().endsWith('exit $rc')).toBe(true);
  });

  it('quotes every docker argument (a gate command with quotes survives the two quoting layers)', () => {
    const script = sshDockerGateScript(WS, RUN_ID, ['run', '--rm', '--name', 'n', 'sh', '-c', `echo "it's $HOME"`]);
    expect(script).toContain(`docker 'run' '--rm' '--name' 'n' 'sh' '-c' 'echo "it'\\''s $HOME"'`);
  });
});
