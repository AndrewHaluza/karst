import type { RemoteDef } from '../../manifest/types.js';
import type {
  PortMapping,
  PublishResult,
  SandboxProbe,
  SessionRunner,
  SetupWindow,
  StepOutcome,
} from '../sessionRunner.js';
import { sshArgv, type SshProcess, type SshResult } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';
import { createTunnelDeps, TunnelOpenError, tunnelLKey, tunnelRKey, windowTunnelRegistry, type TunnelRegistry } from './sshTunnels.js';

/**
 * The services, ports and network-window members of the `mode: direct` ssh
 * runner (D823; `@arch:AC-36`, `@arch:AC-40`, `@arch:AC-47`, `@arch:AC-67`).
 *
 * - A published port is a host `ssh -N -L 127.0.0.1:<hostPort>:127.0.0.1:<port>`
 *   tunnel in the window's registry, keyed `<sandboxName>:L:<hostPort>`.
 * - A baseline host port is an `ssh -N -R` tunnel keyed `<remote>:R:<port>`,
 *   shared by reference count, and ONLY with `remotes.<name>.allowHostServices`.
 * - Service pid, log and env files live in `<ws>/svc` (0700), never in the
 *   shared `/tmp` of a VM; env values reach the remote only on stdin.
 * - A direct remote has no egress control: `setupWindow` is an explicit,
 *   unenforced no-op.
 */

/** The window registry over this ssh process: the default of a runner built without `tunnels`. */
export function defaultSshTunnels(
  ssh: Pick<SshProcess, 'spawnStream'>,
  log: { readonly warn?: (message: string) => void; readonly debug?: (message: string) => void },
): TunnelRegistry {
  return windowTunnelRegistry(createTunnelDeps(ssh, {
    ...(log.warn ? { warn: log.warn } : {}),
    ...(log.debug ? { debug: log.debug } : {}),
  }));
}

export interface SshServicesContext {
  readonly ssh: SshProcess;
  readonly remote: RemoteDef;
  readonly remoteName: string;
  readonly controlDir: string;
  /** The bare sandbox name (`karst-<hash8>-<ticketId>-<core>`): the `-L` key prefix. */
  readonly sandboxName: string;
  readonly ticketId: number;
  /** `<remoteDir>/<name>` */
  readonly workspace: string;
  readonly tunnels: TunnelRegistry;
  /** The runner's workspace probe (one ssh call). */
  readonly probe: () => Promise<SandboxProbe>;
  readonly info?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

export type SshServiceMembers = Required<
  Pick<
    SessionRunner,
    | 'canHostServices'
    | 'publishPort'
    | 'unpublishPort'
    | 'listPorts'
    | 'stopServices'
    | 'allowHostPorts'
    | 'probeRemotePorts'
    | 'setupWindow'
    | 'writeServiceEnv'
    | 'removeServiceEnv'
  >
> & {
  readonly serviceStateDir: string;
  /** Sandbox removal: kill the services, close this sandbox's `-L` tunnels and release this ticket's `-R` keys. */
  readonly releaseAll: () => Promise<void>;
};

const TEXT_STDOUT_BYTES = 64 * 1024;
/** The service key is a `serviceToken` output: a file-name-safe token. */
const SERVICE_KEY_RE = /^[a-z0-9-]+$/;
/** The env names `envArgv` accepts (`sandboxServices.ts`); every other key is dropped by name. */
const SERVICE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `probeRemotePorts` exit code when neither `ss` nor `netstat` exists. */
const NO_PORT_TOOL_EXIT = 46;
/** A port in the local-address column (`127.0.0.1:5432`, `[::]:5432`, `*:5432`). */
const LOCAL_PORT_RE = /:(\d{1,5})$/;

/** The INFO line `setupWindow` logs once per runner. */
export function sshSetupWindowInfo(remoteName: string): string {
  return `ssh ${remoteName}: mode direct has no egress control; the setup window is not enforced`;
}

/** The refusal of a baseline host port without the opt-in (D553). */
export function sshHostServicesRefusal(remoteName: string): string {
  return `ssh ${remoteName}: baseline host services need remotes.${remoteName}.allowHostServices`;
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ssh: ${JSON.stringify(port)} is not a TCP port`);
  return port;
}

function assertServiceKey(key: string): string {
  if (!SERVICE_KEY_RE.test(key)) throw new Error(`ssh: invalid service key ${JSON.stringify(key)}`);
  return key;
}

function lastLine(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

function failure(remoteName: string, step: string, out: SshResult): string {
  const detail = lastLine(out.stderr);
  if (out.transport === true) return `ssh ${remoteName}: transport failed during ${step}: ${detail}`;
  return `ssh ${remoteName}: ${step} failed (exit ${String(out.code)})${detail === '' ? '' : `: ${detail}`}`;
}

/** `<ws>/svc/karst-svc-<key>.env` */
export function sshServiceEnvPath(workspace: string, key: string): string {
  return `${workspace}/svc/karst-svc-${assertServiceKey(key)}.env`;
}

/** The env file body: `export K='…'` lines, quoted like `remoteEnvScript`; sorted. */
export function serviceEnvBody(env: Readonly<Record<string, string>>, debug?: (message: string) => void): string {
  const lines: string[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!SERVICE_ENV_NAME_RE.test(key)) {
      debug?.(`[ssh] service env: dropped the invalid name ${JSON.stringify(key)}`);
      continue;
    }
    lines.push(`export ${key}=${sshQuote(env[key]!)}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** The `<ws>/svc` guard: refused when it is a symlink or not owned by the remote user, checked before and after the `mkdir`. */
function stateDirGuard(stateDir: string): string[] {
  return [
    `sd=${sshQuote(stateDir)}`,
    'refuse() { echo "karst: refusing $sd: $1" >&2; exit 1; }',
    '[ -L "$sd" ] && refuse "it is a symlink"',
    'mkdir -p -m 700 "$sd" || exit 1',
    '[ -L "$sd" ] && refuse "it is a symlink"',
    '[ -O "$sd" ] || refuse "it is not owned by the remote user"',
    'chmod 700 "$sd" || exit 1',
  ];
}

/** Check `<ws>/svc` FIRST, then write the env file from stdin under `umask 077` through a temp + `mv`. */
export function writeServiceEnvScript(stateDir: string, file: string): string {
  return [
    '# karst-ssh-svc-env',
    'umask 077',
    ...stateDirGuard(stateDir),
    `f=${sshQuote(file)}`,
    'cat > "$f.tmp" && chmod 600 "$f.tmp" && mv -f "$f.tmp" "$f"',
  ].join('\n');
}

/**
 * Kill every service recorded in `<ws>/svc`: the process group first (`-<pid>`
 * with no `--`, which the dash `kill` rejects), then the pid. A pid file that
 * does not hold digits > 1 is removed and never signalled (`kill -1`).
 */
export function stopServicesScript(stateDir: string): string {
  return [
    '# karst-ssh-svc-stop',
    `sd=${sshQuote(stateDir)}`,
    '[ -e "$sd" ] || exit 0',
    '[ -L "$sd" ] && { echo "karst: refusing $sd: it is a symlink" >&2; exit 1; }',
    '[ -O "$sd" ] || { echo "karst: refusing $sd: it is not owned by the remote user" >&2; exit 1; }',
    'for f in "$sd"/karst-svc-*.pid; do',
    '  [ -f "$f" ] || continue',
    '  p=$(cat -- "$f")',
    `  case "$p" in ''|*[!0-9]*) p='' ;; esac`,
    '  if [ -n "$p" ] && [ "$p" -gt 1 ]; then kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; fi',
    '  rm -f -- "$f"',
    'done',
    'exit 0',
  ].join('\n');
}

/** One listing of the remote's listening TCP sockets: `ss -ltn`, else `netstat -ltn`. */
export const PORTS_SCRIPT = [
  '# karst-ssh-ports',
  'if command -v ss >/dev/null 2>&1; then exec ss -ltn; fi',
  'if command -v netstat >/dev/null 2>&1; then exec netstat -ltn; fi',
  'echo "karst: neither ss nor netstat is on the remote" >&2',
  `exit ${String(NO_PORT_TOOL_EXIT)}`,
].join('\n');

/** The listening local ports of an `ss -ltn` / `netstat -ltn` listing (field 4 in both). */
export function parseListeningPorts(stdout: string): Set<number> {
  const ports = new Set<number>();
  for (const line of stdout.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    const match = local === undefined ? null : LOCAL_PORT_RE.exec(local);
    if (match === null) continue;
    const port = Number(match[1]);
    if (port >= 1 && port <= 65535) ports.add(port);
  }
  return ports;
}

export function createSshServices(ctx: SshServicesContext): SshServiceMembers {
  const stateDir = `${ctx.workspace}/svc`;
  const argv = (script: string): string[] => sshArgv(ctx.remote, ctx.controlDir, script);
  const run = (script: string): Promise<SshResult> => ctx.ssh.run(argv(script), { maxStdoutBytes: TEXT_STDOUT_BYTES });
  const tunnelRequest = (hostPort: number, remotePort: number) => ({ remote: ctx.remote, controlDir: ctx.controlDir, hostPort, remotePort });
  let windowLogged = false;

  const killServices = async (): Promise<void> => {
    const out = await run(stopServicesScript(stateDir));
    if (out.code !== 0) ctx.debug?.(`[ssh ${ctx.remoteName}] stop services: ${failure(ctx.remoteName, 'service stop', out)}`);
  };

  const closeTunnels = async (): Promise<void> => {
    await ctx.tunnels.closeSandbox(ctx.sandboxName);
    await ctx.tunnels.releaseTicket(ctx.remoteName, ctx.ticketId);
  };

  const allowHostPorts = async (ports: readonly number[]): Promise<StepOutcome> => {
    const wanted = [...new Set(ports.map(assertPort))].sort((a, b) => a - b);
    if (wanted.length > 0 && ctx.remote.allowHostServices !== true) return { ok: false, reason: sshHostServicesRefusal(ctx.remoteName) };
    for (const port of ctx.tunnels.heldR(ctx.remoteName, ctx.ticketId)) {
      if (!wanted.includes(port)) await ctx.tunnels.releaseR(tunnelRKey(ctx.remoteName, port), ctx.ticketId);
    }
    const failed: string[] = [];
    for (const port of wanted) {
      try {
        await ctx.tunnels.acquireR(tunnelRKey(ctx.remoteName, port), ctx.ticketId, tunnelRequest(port, port));
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err));
      }
    }
    return failed.length === 0 ? { ok: true } : { ok: false, reason: failed.join('; ') };
  };

  return {
    serviceStateDir: stateDir,
    canHostServices: async () => (await ctx.probe()).state === 'present',
    writeServiceEnv: async (key, env) => {
      const file = sshServiceEnvPath(ctx.workspace, key);
      const out = await ctx.ssh.runWithStdin(
        argv(writeServiceEnvScript(stateDir, file)),
        Buffer.from(serviceEnvBody(env, ctx.debug), 'utf8'),
        { maxStdoutBytes: TEXT_STDOUT_BYTES },
      );
      if (out.code !== 0) throw new Error(failure(ctx.remoteName, 'service env write', out));
      return file;
    },
    removeServiceEnv: async (key) => {
      const out = await run(`# karst-ssh-svc-env-rm\nrm -f -- ${sshQuote(sshServiceEnvPath(ctx.workspace, key))}`);
      if (out.code !== 0) ctx.debug?.(`[ssh ${ctx.remoteName}] ${failure(ctx.remoteName, 'service env removal', out)}`);
    },
    publishPort: async (mapping: PortMapping): Promise<PublishResult> => {
      try {
        await ctx.tunnels.openL(tunnelLKey(ctx.sandboxName, mapping.hostPort), tunnelRequest(mapping.hostPort, mapping.sandboxPort));
        return { ok: true };
      } catch (err) {
        if (err instanceof TunnelOpenError) return { ok: false, reason: err.message, portTaken: err.portTaken };
        return { ok: false, reason: err instanceof Error ? err.message : String(err), portTaken: false };
      }
    },
    unpublishPort: (mapping) => ctx.tunnels.closeL(tunnelLKey(ctx.sandboxName, mapping.hostPort)),
    listPorts: async () => {
      if ((await ctx.probe()).state === 'unknown') return null;
      // A `down` tunnel is not live: leaving it out makes `reverifySandboxServices` republish it.
      return ctx.tunnels
        .forSandbox(ctx.sandboxName)
        .filter((h) => h.state !== 'down')
        .map((h) => ({ hostPort: h.hostPort, sandboxPort: h.remotePort }));
    },
    stopServices: async () => {
      await killServices();
      await closeTunnels();
    },
    allowHostPorts,
    probeRemotePorts: async (ports) => {
      const wanted = ports.map(assertPort);
      if (wanted.length === 0) return [];
      const out = await run(PORTS_SCRIPT);
      if (out.transport === true || out.code !== 0) throw new Error(failure(ctx.remoteName, 'remote port probe', out));
      const listening = parseListeningPorts(out.stdout);
      return [...new Set(wanted.filter((p) => listening.has(p)))];
    },
    setupWindow: async (): Promise<SetupWindow> => {
      if (!windowLogged) {
        windowLogged = true;
        ctx.info?.(sshSetupWindowInfo(ctx.remoteName));
      }
      return { ok: true, enforced: false, close: async () => undefined };
    },
    releaseAll: async () => {
      await killServices();
      await closeTunnels();
    },
  };
}
