import { SANDBOX_BRIDGE_MOUNT_ROOT } from '../bridge/bridgeDir.js';
import { containerBinary, type DockerCore, OPENCODE_IMAGE } from './dockerImage.js';
import type { DockerNames } from './dockerNames.js';
import { PROXY_URL } from './proxySidecar.js';

/** The ticket clone inside the container (the placed cwd of every command). */
export const CONTAINER_REPO = '/work/repo';
export const CONTAINER_WORK = '/work';
/** opencode's data dir: v1 sessions + `auth.json`, and (under `xdg/`) the v2 store. */
export const CONTAINER_DATA = '/home/node/.local/share/opencode';
const CONTAINER_HOME = '/home/node';

/** Linux only: bind/volume writes keep the host uid (ST2B blocker 5). */
export interface LinuxUser {
  readonly uid: number;
  readonly gid: number;
}

const XDG_DIRS: Readonly<Record<string, string>> = {
  XDG_DATA_HOME: 'data',
  XDG_CONFIG_HOME: 'config',
  XDG_CACHE_HOME: 'cache',
  XDG_STATE_HOME: 'state',
};

/** The v2 XDG dirs inside the container, on the data volume so credentials persist. */
export function containerXdgEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(XDG_DIRS).map(([key, dir]) => [key, `${CONTAINER_DATA}/xdg/${dir}`]));
}

export function userArgs(user: LinuxUser | undefined): string[] {
  if (!user) return [];
  return ['--user', `${user.uid}:${user.gid}`, '--tmpfs', `${CONTAINER_HOME}:uid=${user.uid},gid=${user.gid},mode=0700`];
}

export const HARDENING = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

/**
 * Docker's own init as PID 1 (tini). Without it PID 1 is the agent, the gate or
 * `sleep infinity` — none of which reap. A descendant that outlives its
 * process-group kill then reparents to PID 1 and sits there as a ZOMBIE:
 * `process.kill(pid, 0)` keeps answering "alive", so `killTree`'s contract and
 * every "is that process gone?" check in the repo's own suites read a corpse as
 * a survivor (the sandbox gate suite fails on the process-tree, port and
 * supervisor cases). `--init` reaps them.
 *
 * Liveness, not hardening, so it is deliberately NOT part of `HARDENING`: only
 * containers that HOST repo processes need it (the interactive session, the
 * one-shot gate, the UAT service container). The throwaway `git`/`chown`
 * one-shots do not.
 */
export const REAPER = ['--init'];

/**
 * A `--mount type=bind` value. `--mount` is comma-separated, so a host path
 * holding `,` (or a newline) could inject mount options: refused, the caller
 * fails closed with the reason.
 */
export function bindMount(source: string, target: string, readonly: boolean): string {
  if (/[,\n]/.test(source)) throw new Error(`docker: unsafe bind path ${JSON.stringify(source)}`);
  return `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;
}

const PROXY_ENV = [
  `HTTPS_PROXY=${PROXY_URL}`, `HTTP_PROXY=${PROXY_URL}`,
  `https_proxy=${PROXY_URL}`, `http_proxy=${PROXY_URL}`,
  'NO_PROXY=localhost,127.0.0.1', 'no_proxy=localhost,127.0.0.1',
];

/**
 * `--env` flags for the adapter's env. Host XDG paths (opencode2's isolated
 * store) are remapped onto the data volume, with their value in the argv:
 * a container path is no secret. Every other key is passed BY NAME, so its
 * value comes from the docker client's own env and never lands in the argv
 * (`ps`, `docker inspect` of the client). Terminal type keys ride along.
 */
export function envArgs(env: Readonly<Record<string, string>>): string[] {
  const xdg = containerXdgEnv();
  const flags: string[] = [];
  for (const key of Object.keys(env).sort()) {
    flags.push('--env', key in xdg ? `${key}=${xdg[key]!}` : key);
  }
  for (const entry of [...PROXY_ENV, 'TERM', 'COLORTERM']) flags.push('--env', entry);
  return flags;
}

/** Host worktree path (exact, or as a path prefix) → the container clone. */
export function rewritePaths(args: readonly string[], hostWorktreePath: string): string[] {
  const prefix = hostWorktreePath.endsWith('/') ? hostWorktreePath : `${hostWorktreePath}/`;
  return args.map((arg) => {
    if (arg === hostWorktreePath) return CONTAINER_REPO;
    if (arg.startsWith(prefix)) return `${CONTAINER_REPO}/${arg.slice(prefix.length)}`;
    return arg;
  });
}

export function volumeMounts(names: DockerNames, opts: { readonly repoReadonly?: boolean } = {}): string[] {
  return [
    '--mount', `type=volume,source=${names.repoVolume},target=${CONTAINER_WORK}${opts.repoReadonly ? ',readonly' : ''}`,
    '--mount', `type=volume,source=${names.dataVolume},target=${CONTAINER_DATA}`,
  ];
}

export interface InteractiveArgsInput {
  readonly names: DockerNames;
  readonly core: DockerCore;
  readonly user: LinuxUser | undefined;
  /** Host opencode v1 `auth.json`, mounted read-only over the data volume. */
  readonly authFile: string | undefined;
  readonly hostWorktreePath: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly ticketId?: number;
  /** Host evidence-bridge dir, mounted read-write (arch:AC-34). */
  readonly bridgeDir?: string;
}

/**
 * The interactive `docker run`. Only the ticket network (internal, the proxy
 * its one way out), the two named volumes and the optional read-only auth
 * file. Never `--privileged`, never the docker socket, never a host worktree
 * or `.git` mount (clone mode removes ST2B blocker 1).
 */
export function interactiveRunArgs(input: InteractiveArgsInput): string[] {
  const auth = input.authFile
    ? ['--mount', bindMount(input.authFile, `${CONTAINER_DATA}/auth.json`, true)]
    : [];
  if (input.bridgeDir !== undefined && input.ticketId === undefined) {
    throw new Error('karst: a bridge mount needs a ticketId');
  }
  const bridge =
    input.bridgeDir !== undefined
      ? ['--mount', bindMount(input.bridgeDir, `${SANDBOX_BRIDGE_MOUNT_ROOT}/${input.ticketId}`, false)]
      : [];
  return [
    'run', '--interactive', '--tty', '--rm', ...REAPER, '--name', input.names.container,
    '--network', input.names.network, ...HARDENING,
    ...volumeMounts(input.names), ...auth, ...bridge, ...userArgs(input.user),
    ...envArgs(input.env), '--workdir', CONTAINER_REPO,
    OPENCODE_IMAGE, containerBinary(input.core), ...rewritePaths(input.args, input.hostWorktreePath),
  ];
}

const RUN_ID = /^[a-z0-9]{1,32}$/;
/** Records the process id so an abort can kill it: a dead `docker exec` client does not. */
const PID_SCRIPT = 'echo $$ > "/tmp/karst-run-$1.pid"; shift; exec "$@"';
const KILL_SCRIPT = 'f="/tmp/karst-run-$1.pid"; [ -f "$f" ] && kill -KILL "$(cat "$f")" 2>/dev/null; rm -f "$f"';

function checkRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`docker exec: unsafe run id ${JSON.stringify(runId)}`);
  return runId;
}

/** Headless: `docker exec` into the ticket's container; the command is argv, the script fixed. */
export function headlessExecArgs(
  container: string,
  runId: string,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): string[] {
  // Only karst-made, non-secret values (a container path) ride here as `K=V`.
  const envFlags = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  return [
    'exec', '--interactive', ...envFlags, '--workdir', CONTAINER_REPO, container,
    'sh', '-c', PID_SCRIPT, 'karst-run', checkRunId(runId), command, ...args,
  ];
}

export function headlessKillArgs(container: string, runId: string): string[] {
  return ['exec', container, 'sh', '-c', KILL_SCRIPT, 'karst-kill', checkRunId(runId)];
}

/**
 * A one-shot gate container for when the interactive one (`--rm`) is gone: the
 * same internal network, hardening, volumes and uid, so the gate still sees
 * the clone and still has only the proxy as a way out.
 */
export function gateRunArgs(
  names: DockerNames,
  user: LinuxUser | undefined,
  runName: string,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): string[] {
  const envFlags = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  return [
    'run', '--rm', ...REAPER, '--name', runName, '--network', names.network, ...HARDENING,
    ...volumeMounts(names), ...userArgs(user),
    ...envFlags, ...PROXY_ENV.flatMap((e) => ['--env', e]), '--workdir', CONTAINER_REPO,
    OPENCODE_IMAGE, command, ...args,
  ];
}

/** Name of the detached service container; it outlives the interactive `--rm` one. */
export function serviceContainerName(names: DockerNames): string {
  return `${names.container}-svc`;
}

/**
 * A detached, hardened container on the clone volume for UAT services when the
 * interactive container is gone. Same network (aliased as the interactive
 * container, which is what the port relays target), hardening, volumes and uid.
 */
export function serviceRunArgs(names: DockerNames, user: LinuxUser | undefined): string[] {
  return [
    'run', '-d', ...REAPER, '--name', serviceContainerName(names), '--network', names.network,
    '--network-alias', names.container, ...HARDENING,
    ...volumeMounts(names), ...userArgs(user),
    ...PROXY_ENV.flatMap((e) => ['--env', e]), '--workdir', CONTAINER_REPO,
    OPENCODE_IMAGE, 'sleep', 'infinity',
  ];
}
