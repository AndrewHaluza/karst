import { randomBytes } from 'node:crypto';
import type { RemoteDef } from '../../manifest/types.js';
import { runProcess, type GateProcessRunner } from '../../workflow/gates/run.js';
import { disposeResult, disposeStep, type DisposeResult, type DisposeStep } from '../disposeResult.js';
import type { SbxProcess } from '../sbx/sbxProcess.js';
import type { SshCore } from '../sandboxCores.js';
import { SHELL_NO_SANDBOX } from '../sandboxShell.js';
import type {
  InteractiveLaunchSpec,
  PlacedInteractiveLaunch,
  RefreshOptions,
  SandboxProbe,
  SandboxTicketRef,
  SessionRunner,
  StepOutcome,
} from '../sessionRunner.js';
import {
  diffSshClone,
  fetchSshClone,
  rebuildSshCheck,
  refreshSshClone,
  sshCloneReady,
  sshRemotePaths,
  syncFromSshClone,
  type SshCloneContext,
  type SshRemotePaths,
} from './sshClone.js';
import { disposeTarget } from './sshDisposeGuard.js';
import { remoteEnv, remoteEnvScript, rewriteEmbeddedHostPaths } from './sshEnv.js';
import { sweepScript } from './sshGateScript.js';
import { sshGateKey, WINDOW_SSH_GATE_REGISTRY, type SshGateRegistry } from './sshGateRegistry.js';
import { SANDBOX_NAME_RE } from './sshNames.js';
import { uploadBridgeScripts } from './sshBridge.js';
import { SSH_BIN, sshArgv, type SshProcess, type SshResult } from './sshProcess.js';
import { killRemoteGate, GATE_KILL_GRACE_SECONDS, sshRunGate, type SshGateContext } from './sshRunGate.js';
import { remoteSh, sshQuote } from './sshQuote.js';
import { createSshServices, defaultSshTunnels } from './sshServices.js';
import type { TunnelRegistry } from './sshTunnels.js';

/**
 * The `mode: direct` ssh runner (D555, edit 6). The agent runs PROMPTED on the
 * remote (`enforcesSandbox: false`, `@arch:AC-31`): a VM the user owns is a
 * placement, not an autonomy boundary. Every ssh argv is
 * `[...sshOptions, flags, '--', dest, 'sh -c …']` (`sshArgv`), every remote
 * string goes through `sshQuote`, and no env value is ever on an argv: the env
 * file goes over stdin. No `runHeadless` (`@arch:AC-46`).
 */

export interface SshRunnerOptions {
  readonly ssh: SshProcess;
  /** The ssh executable of the terminal and of `pipe`; `SSH_BIN` in production. */
  readonly sshBin?: string;
  /** Host-side git (bundle fetch and merge). */
  readonly host: SbxProcess;
  readonly remote: RemoteDef;
  readonly remoteName: string;
  /** `karst-<hash8>-<ticketId>-<core>`; also the tmux session name. */
  readonly sandboxName: string;
  /** `sshProjectPrefix(projectRoot, installId)`: `dispose` refuses a name outside it. */
  readonly projectPrefix: string;
  readonly controlDir: string;
  readonly core: SshCore;
  readonly ticketId: number;
  readonly hostWorktreePath: string;
  /** The preflight found tmux: the session survives a dropped connection. */
  readonly tmux: boolean;
  /** `<globalStorage>`: the dir of `ssh-trust.json`, re-read by the launch upload (D553). */
  readonly trustDir?: string;
  /** The core binary that the preflight resolved on the remote (`command -v <core>`); default the core name. */
  readonly coreBin?: string;
  readonly registry?: SshGateRegistry;
  readonly newRunId?: () => string;
  /** The host gate boundary `runGate` wraps (default `runProcess`). */
  readonly gateProcess?: GateProcessRunner;
  /** TERM → KILL grace of a remote gate kill (default 10 s; tests use 0). */
  readonly killGraceSeconds?: number;
  /** The window's tunnel registry (D823); default `windowTunnelRegistry` over `opts.ssh`. */
  readonly tunnels?: TunnelRegistry;
  /** INFO lines (the unenforced setup window); bound to the window logger. */
  readonly info?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

/** `oomReport` is best effort and bounded. */
export const SSH_OOM_TIMEOUT_MS = 8_000;
const TEXT_STDOUT_BYTES = 64 * 1024;
/** `probeSandbox` exit code for "no clone"; every other failure is `unknown` (`@arch:AC-36`). */
const PROBE_ABSENT_EXIT = 44;
/** `prepareInteractive` exit code for a refused dir (symlink or foreign owner). */
const PREPARE_REFUSED_EXIT = 45;

function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

/** The tmux exact-match target: a bare name prefix-matches (`…-opencode` would hit `…-opencode2`). */
function tmuxTarget(name: string): string {
  return sshQuote(`=${name}`);
}

function assertSessionName(name: string): string {
  if (!SANDBOX_NAME_RE.test(name)) throw new Error(`ssh: invalid sandbox name ${JSON.stringify(name)}`);
  return name;
}

/** The remote bridge run dir; it MUST end in the numeric ticket id (`MARKER_EMIT` reads it from there). */
export function sshBridgeRunDir(paths: SshRemotePaths, ticketId: number): string {
  return `${paths.bridge}/${String(ticketId)}`;
}

export interface InteractiveScriptInput {
  readonly paths: SshRemotePaths;
  readonly name: string;
  readonly coreBin: string;
  readonly args: readonly string[];
  readonly tmux: boolean;
  readonly reattach: boolean;
}

/**
 * The remote script of an interactive launch. `cmd` runs the core in the repo
 * with the env file sourced. With tmux the pane command is `sh -c '<cmd>'`
 * (tmux runs a bare string through its `default-shell`, maybe fish or csh). A
 * launch kills and recreates the session so the new args apply; a reattach
 * attaches to a live session and never kills it.
 */
export function interactiveScript(input: InteractiveScriptInput): string {
  const cmd = [
    `cd ${sshQuote(input.paths.repo)}`,
    `. ${sshQuote(`${input.paths.env}/env.sh`)}`,
    `exec ${[input.coreBin, ...input.args].map(sshQuote).join(' ')}`,
  ].join(' && ');
  if (!input.tmux) return cmd;
  const name = assertSessionName(input.name);
  const launch = `tmux kill-session -t ${tmuxTarget(name)} 2>/dev/null; exec tmux new-session -s ${sshQuote(name)} ${sshQuote(remoteSh(cmd))}`;
  if (!input.reattach) return launch;
  return `if tmux has-session -t ${tmuxTarget(name)} 2>/dev/null; then exec tmux attach -t ${tmuxTarget(name)}; else ${launch}; fi`;
}

/**
 * The dirs a launch needs, mode 0700, each refused when it is a symlink or
 * not owned by the remote user (`[ -L ]`, `[ -O ]`: portable, no `stat -c`).
 * Then the env file from stdin, under `umask 077`, through a temp + `mv`.
 */
function prepareScript(paths: SshRemotePaths, runDir: string): string {
  const dirs = [paths.workspace, paths.bridge, runDir, `${runDir}/results`, `${runDir}/inbox`, paths.gates, paths.env];
  return [
    '# karst-ssh-prepare',
    'umask 077',
    `refuse() { echo "karst: refusing $1: $2" >&2; exit ${String(PREPARE_REFUSED_EXIT)}; }`,
    'mkd() {',
    '  [ -L "$1" ] && refuse "$1" "it is a symlink"',
    '  mkdir -p -m 700 "$1" || exit 1',
    '  [ -L "$1" ] && refuse "$1" "it is a symlink"',
    '  [ -O "$1" ] || refuse "$1" "it is not owned by the remote user"',
    '  chmod 700 "$1" || exit 1',
    '}',
    ...dirs.map((d) => `mkd ${sshQuote(d)}`),
    `e=${sshQuote(`${paths.env}/env.sh`)}`,
    'cat > "$e.tmp" && chmod 600 "$e.tmp" && mv -f "$e.tmp" "$e"',
  ].join('\n');
}

function shellQuoteFailure(remoteName: string, step: string, out: SshResult): string {
  if (out.transport === true) return `ssh ${remoteName}: transport failed during ${step}: ${tail(out.stderr)}`;
  return `ssh ${remoteName}: ${step} failed (exit ${String(out.code)})${tail(out.stderr) === '' ? '' : `: ${tail(out.stderr)}`}`;
}

export function createSshSessionRunner(opts: SshRunnerOptions): SessionRunner {
  const sshBin = opts.sshBin ?? SSH_BIN;
  const registry = opts.registry ?? WINDOW_SSH_GATE_REGISTRY;
  const registryKey = sshGateKey(opts.remoteName, opts.sandboxName);
  const cloneCtx: SshCloneContext = {
    ssh: opts.ssh, sshBin, host: opts.host, remote: opts.remote, remoteName: opts.remoteName,
    sandboxName: opts.sandboxName, controlDir: opts.controlDir, ...(opts.debug ? { debug: opts.debug } : {}),
  };
  const paths = sshRemotePaths(cloneCtx);
  const runDir = sshBridgeRunDir(paths, opts.ticketId);
  const gateCtx: SshGateContext = {
    ssh: opts.ssh, sshBin, remote: opts.remote, remoteName: opts.remoteName, controlDir: opts.controlDir,
    workspace: paths.workspace, hostWorktreePath: opts.hostWorktreePath, registry, registryKey,
    newRunId: opts.newRunId ?? (() => randomBytes(8).toString('hex')),
    gateProcess: opts.gateProcess ?? runProcess,
    killGraceSeconds: opts.killGraceSeconds ?? GATE_KILL_GRACE_SECONDS,
    ...(opts.debug ? { debug: opts.debug } : {}),
  };
  const argv = (script: string, flags?: readonly string[]): string[] =>
    sshArgv(opts.remote, opts.controlDir, script, flags ? { flags } : {});
  const run = (script: string, extra: { readonly signal?: AbortSignal } = {}): Promise<SshResult> =>
    opts.ssh.run(argv(script), { maxStdoutBytes: TEXT_STDOUT_BYTES, ...extra });
  const cloneInput = (t: SandboxTicketRef) => ({ hostWorktreePath: t.hostWorktreePath, branch: t.branch, ...(t.baseRef ? { baseRef: t.baseRef } : {}) });

  /** Kill every gate group in `<ws>` whose run id is not live in this window's registry. */
  const sweepOrphans = async (): Promise<void> => {
    const out = await run(sweepScript(paths.workspace, [...registry.live(registryKey)]));
    if (out.code !== 0) opts.debug?.(`[ssh ${opts.remoteName}] orphan gate sweep: ${shellQuoteFailure(opts.remoteName, 'sweep', out)}`);
  };

  const probe = async (): Promise<SandboxProbe> => {
    const out = await run(`# karst-ssh-probe\nif [ -e ${sshQuote(`${paths.repo}/.git`)} ]; then exit 0; fi\nexit ${String(PROBE_ABSENT_EXIT)}`);
    if (out.transport !== true && out.code === 0) return { state: 'present' };
    if (out.transport !== true && out.code === PROBE_ABSENT_EXIT) return { state: 'absent' };
    return { state: 'unknown', reason: shellQuoteFailure(opts.remoteName, 'sandbox probe', out) };
  };

  const stop = async (): Promise<void> => {
    const name = assertSessionName(opts.sandboxName);
    const killed = await run(`# karst-ssh-stop\ntmux kill-session -t ${tmuxTarget(name)} 2>/dev/null\nexit 0`);
    if (killed.code !== 0) opts.debug?.(`[ssh ${opts.remoteName}] stop: ${shellQuoteFailure(opts.remoteName, 'tmux kill-session', killed)}`);
    await Promise.all([...registry.live(registryKey)].map((runId) => killRemoteGate(gateCtx, runId)));
  };

  const services = createSshServices({
    ssh: opts.ssh, remote: opts.remote, remoteName: opts.remoteName, controlDir: opts.controlDir,
    sandboxName: opts.sandboxName, ticketId: opts.ticketId, workspace: paths.workspace,
    tunnels: opts.tunnels ?? defaultSshTunnels(opts.ssh, opts), probe,
    ...(opts.info ? { info: opts.info } : {}), ...(opts.debug ? { debug: opts.debug } : {}),
  });
  const { releaseAll, ...serviceMembers } = services;

  const dispose = async (): Promise<DisposeResult> => {
    const target = disposeTarget(opts.remote.remoteDir, opts.sandboxName, opts.projectPrefix);
    if (!target.ok || target.path !== paths.workspace) {
      const reason = target.ok ? `ssh dispose: refused ${target.path} (not the workspace ${paths.workspace})` : target.reason;
      return disposeResult([{ step: 'dispose guard', status: 'failed', stderr: reason }]);
    }
    await stop();
    // The services run detached: kill them, then close this sandbox's tunnels and stop their watchers.
    await releaseAll();
    const removed = await run(`# karst-ssh-dispose\nrm -rf -- ${sshQuote(target.path)}`);
    const step: DisposeStep = removed.transport === true
      ? { step: 'workspace', status: 'failed', stderr: shellQuoteFailure(opts.remoteName, 'workspace removal', removed) }
      : disposeStep('workspace', removed);
    return disposeResult([step]);
  };

  return {
    kind: 'ssh',
    enforcesSandbox: false,
    autonomous: false,
    prepareInteractive: async (spec: InteractiveLaunchSpec): Promise<void> => {
      const env = remoteEnv(spec.env, {
        hostWorktreePath: spec.hostWorktreePath,
        remoteWorktreePath: paths.repo,
        ...(spec.bridgeDir !== undefined ? { hostBridgeDir: spec.bridgeDir } : {}),
        remoteBridgeDir: runDir,
      }, opts.debug);
      const body = `${remoteEnvScript(env)}\n`;
      const out = await opts.ssh.runWithStdin(argv(prepareScript(paths, runDir)), Buffer.from(body, 'utf8'), { maxStdoutBytes: TEXT_STDOUT_BYTES });
      if (out.code !== 0) throw new Error(shellQuoteFailure(opts.remoteName, 'launch preparation', out));
      // D556 edit 3: the adapters wrote their scripts into the host bridge dir;
      // put them in the remote run dir the marker command and hooks name.
      if (spec.bridgeDir !== undefined) {
        const upload = await uploadBridgeScripts({
          ssh: opts.ssh, remote: opts.remote, remoteName: opts.remoteName, core: opts.core,
          hostBridgeDir: spec.bridgeDir, runDir, ...(opts.trustDir !== undefined ? { trustDir: opts.trustDir } : {}),
          ...(opts.debug ? { debug: opts.debug } : {}),
        });
        if (!upload.ok) throw new Error(upload.reason);
      }
      await sweepOrphans();
    },
    placeInteractive: (spec: InteractiveLaunchSpec): PlacedInteractiveLaunch => {
      const repoArgs = rewriteEmbeddedHostPaths(spec.args, spec.hostWorktreePath, paths.repo);
      const args = spec.bridgeDir === undefined ? repoArgs : rewriteEmbeddedHostPaths(repoArgs, spec.bridgeDir, runDir);
      const script = interactiveScript({
        paths, name: opts.sandboxName, coreBin: opts.coreBin ?? opts.core, args,
        tmux: opts.tmux, reattach: spec.reattach === true,
      });
      // The local ssh client gets no launch env: the remote env is the env file.
      return { cwd: spec.hostWorktreePath, shellPath: sshBin, shellArgs: argv(script, ['-t']), env: {} };
    },
    bridgeRunDir: () => runDir,
    sync: (ticket) => syncFromSshClone(cloneCtx, cloneInput(ticket)),
    refresh: (ticket, refreshOpts?: RefreshOptions) => refreshSshClone(cloneCtx, cloneInput(ticket), refreshOpts),
    fetchClone: (ticket) => fetchSshClone(cloneCtx, cloneInput(ticket)),
    diff: (ticket) => diffSshClone(cloneCtx, cloneInput(ticket)),
    ensureCloneReady: (branch) => sshCloneReady(cloneCtx, branch),
    rebuild: async (ticket): Promise<DisposeResult> => {
      const safe = await rebuildSshCheck(cloneCtx, cloneInput(ticket));
      if (!safe.ok) return disposeResult([{ step: 'rebuild guard', status: 'failed', stderr: safe.reason }]);
      return dispose();
    },
    runGate: sshRunGate(gateCtx),
    ...serviceMembers,
    probeSandbox: probe,
    hasSandbox: async () => (await probe()).state === 'present',
    stop,
    dispose,
    shellCommand: async () => {
      const state = await probe();
      if (state.state === 'unknown') return { ok: false, reason: state.reason };
      if (state.state === 'absent') return { ok: false, reason: SHELL_NO_SANDBOX };
      return { ok: true, cmd: sshBin, args: argv(`cd ${sshQuote(paths.repo)} && exec "$SHELL" -l`, ['-t']) };
    },
    ensureWritable: async (): Promise<StepOutcome> => {
      const out = await run(`# karst-ssh-write-probe\ncd ${sshQuote(paths.repo)} && f=".karst-write-probe.$$" && : > "$f" && rm -f -- "$f"`);
      if (out.transport !== true && out.code === 0) return { ok: true };
      return {
        ok: false,
        reason: `${shellQuoteFailure(opts.remoteName, `write probe in ${paths.repo}`, out)}. Free disk space or fix the permissions on the remote, then Karst: Open AI Session`,
      };
    },
    oomReport: async (): Promise<string> => {
      const out = await run(`# karst-ssh-oom\ndmesg 2>/dev/null | grep -i 'killed process' | tail -3`, { signal: AbortSignal.timeout(SSH_OOM_TIMEOUT_MS) })
        .catch(() => undefined);
      const lines = out && out.code === 0 ? out.stdout.trim() : '';
      return lines === ''
        ? `ssh ${opts.remoteName}: the session was killed (exit 137); the remote kernel log shows no out-of-memory record (or is not readable)`
        : `ssh ${opts.remoteName}: the remote ran out of memory and killed a process:\n${lines}`;
    },
  };
}
