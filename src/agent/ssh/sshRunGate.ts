import type { RemoteDef } from '../../manifest/types.js';
import type { GateOutputChunk, GateProcessRunner, ProcessOutcome, RunProcessOptions } from '../../workflow/gates/run.js';
import {
  assertRunId,
  gateScript,
  killGateScript,
  parsePgid,
  readExitScript,
  readPgidScript,
  verdictFromExitFile,
  verdictFromStderr,
} from './sshGateScript.js';
import type { SshGateRegistry } from './sshGateRegistry.js';
import { sshArgv, type SshProcess } from './sshProcess.js';
import { rewriteEmbeddedHostPaths, rewriteHostPaths } from './sshEnv.js';

/**
 * `runGate` of the ssh runner (D555, edit 6; `@arch:STAGEMACH`). The gate runs
 * through the host gate boundary (`runProcess` by default) as a local `ssh`
 * process, so the timeout, the abort, the bounded output and the live stream
 * stay the host's. The verdict never comes from that local exit code alone,
 * and never from a record that the local code does not confirm: see
 * `sshGateScript.ts` for the rule.
 */

/** Seconds between the TERM and the KILL of a remote gate group. */
export const GATE_KILL_GRACE_SECONDS = 10;

/** The stderr tail kept for the marker fallback (the bounded `output` keeps only the head). */
const STDERR_TAIL_BYTES = 64 * 1024;

/** The bound for the small remote reads (exit file, pgid). */
const SMALL_STDOUT_BYTES = 4096;

/** The bound of one follow-up ssh call (exit file, pgid, kill); the kill adds its grace. */
const REMOTE_STEP_TIMEOUT_MS = 60_000;

export interface SshGateContext {
  readonly ssh: SshProcess;
  readonly sshBin: string;
  readonly remote: RemoteDef;
  readonly remoteName: string;
  readonly controlDir: string;
  /** `<remoteDir>/<name>` */
  readonly workspace: string;
  readonly hostWorktreePath: string;
  readonly registry: SshGateRegistry;
  readonly registryKey: string;
  readonly newRunId: () => string;
  readonly gateProcess: GateProcessRunner;
  readonly killGraceSeconds: number;
  readonly debug?: (message: string) => void;
}

function lastLine(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

/** Keeps the end of the stderr stream; a line split across chunks stays whole. */
function stderrTail(): { readonly push: (chunk: GateOutputChunk) => void; readonly text: () => string } {
  let tail = '';
  return {
    push: (chunk) => {
      if (chunk.stream !== 'stderr') return;
      tail += chunk.text;
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.slice(tail.length - STDERR_TAIL_BYTES);
    },
    text: () => tail,
  };
}

function remoteRun(ctx: SshGateContext, script: string): Promise<{ code: number; stdout: string; transport: boolean; stderr: string }> {
  return ctx.ssh
    .run(sshArgv(ctx.remote, ctx.controlDir, script), { maxStdoutBytes: SMALL_STDOUT_BYTES, signal: AbortSignal.timeout(REMOTE_STEP_TIMEOUT_MS + ctx.killGraceSeconds * 1000) })
    .then(
      (r) => ({ code: r.code, stdout: r.stdout, stderr: r.stderr, transport: r.transport === true }),
      (err: unknown) => ({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err), transport: false }),
    );
}

/**
 * Kill one remote gate by its recorded process group. The local ssh kill does
 * not reach the remote group, so a timeout, an abort and `stop` all use this.
 */
export async function killRemoteGate(ctx: SshGateContext, runId: string): Promise<void> {
  const read = await remoteRun(ctx, readPgidScript(ctx.workspace, runId));
  const pgid = read.code === 0 ? parsePgid(read.stdout) : undefined;
  if (pgid === undefined) {
    ctx.debug?.(`[ssh ${ctx.remoteName}] gate ${runId}: no live process group to kill`);
    return;
  }
  ctx.debug?.(`[ssh ${ctx.remoteName}] gate ${runId}: kill -TERM -${String(pgid)}`);
  const killed = await remoteRun(ctx, killGateScript(ctx.workspace, runId, pgid, ctx.killGraceSeconds));
  if (killed.code !== 0) ctx.debug?.(`[ssh ${ctx.remoteName}] gate ${runId}: kill exited ${String(killed.code)}: ${lastLine(killed.stderr)}`);
}

type MappedCwd = { readonly ok: true; readonly cwd: string } | { readonly ok: false; readonly reason: string };

function mapCwd(ctx: SshGateContext, cwd: string): MappedCwd {
  const repo = `${ctx.workspace}/repo`;
  const [mapped] = rewriteHostPaths([cwd], ctx.hostWorktreePath, repo);
  if (mapped === undefined || (mapped !== repo && !mapped.startsWith(`${repo}/`))) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: gate cwd ${cwd} is outside the ticket worktree` };
  }
  return { ok: true, cwd: mapped };
}

type MappedEnvFile = { readonly ok: true; readonly file: string | undefined } | { readonly ok: false; readonly reason: string };

/**
 * The caller's service env file (D823): only a file under `<ws>/`, with no
 * `.`/`..` segment, so a gate never sources a file of another workspace.
 */
export function mapEnvFile(ctx: Pick<SshGateContext, 'workspace' | 'remoteName'>, envFile: string | undefined): MappedEnvFile {
  if (envFile === undefined) return { ok: true, file: undefined };
  const rest = envFile.startsWith(`${ctx.workspace}/`) ? envFile.slice(ctx.workspace.length + 1) : undefined;
  const segments = rest?.split('/') ?? [];
  if (rest === undefined || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: env file ${envFile} is outside the workspace ${ctx.workspace}` };
  }
  return { ok: true, file: envFile };
}

/** The ssh client's own failure code; a gate can also really exit 255. */
const SSH_TRANSPORT_EXIT = 255;

type Verdict = { ok: true; code: number } | { ok: false; reason: string };

/**
 * Check a record (exit file or stderr marker) against the local ssh exit code.
 * A process that the gate leaves behind runs as the same remote user, so it
 * can rewrite the exit file or print a late marker. It cannot change the exit
 * status that sshd sends back for the wrapper's `exit $rc`. So a record counts
 * only when the local code agrees with it. A local 255 is either a transport
 * failure or a real 255: only a record of 255 confirms it.
 */
export function confirmRecord(remoteName: string, record: number, localCode: number): Verdict {
  if (record === localCode) return { ok: true, code: record };
  if (localCode === SSH_TRANSPORT_EXIT) {
    return { ok: false, reason: `ssh ${remoteName}: the gate record says ${String(record)}, but ssh exited 255 (a transport failure cannot confirm it)` };
  }
  return { ok: false, reason: `ssh ${remoteName}: the gate record says ${String(record)}, but the gate wrapper exited ${String(localCode)}; no verdict` };
}

/** The verdict after a completed local run: the exit file first, the stderr marker only when it is missing; each checked against the local code. */
async function verdict(ctx: SshGateContext, runId: string, localCode: number, stderr: string): Promise<Verdict> {
  const read = await remoteRun(ctx, readExitScript(ctx.workspace, runId));
  if (read.code === 0) {
    const fromFile = verdictFromExitFile(read.stdout, runId);
    if (fromFile !== undefined) return confirmRecord(ctx.remoteName, fromFile, localCode);
    ctx.debug?.(`[ssh ${ctx.remoteName}] gate ${runId}: exit file unreadable, using the stderr marker`);
  }
  const fromStderr = verdictFromStderr(stderr, runId);
  if (fromStderr !== undefined) return confirmRecord(ctx.remoteName, fromStderr, localCode);
  const tail = lastLine(stderr);
  if (localCode === SSH_TRANSPORT_EXIT) return { ok: false, reason: `ssh transport failed: ${tail}` };
  return { ok: false, reason: `ssh ${ctx.remoteName}: the gate left no exit record (ssh exit ${String(localCode)})${tail === '' ? '' : `: ${tail}`}` };
}

export function sshRunGate(ctx: SshGateContext): GateProcessRunner {
  return async (command, args, cwd, gateOpts?: RunProcessOptions): Promise<ProcessOutcome> => {
    const mapped = mapCwd(ctx, cwd);
    if (!mapped.ok) return { kind: 'spawnFailed', message: mapped.reason, output: '' };
    const extra = mapEnvFile(ctx, gateOpts?.envFile);
    if (!extra.ok) return { kind: 'spawnFailed', message: extra.reason, output: '' };
    const runId = assertRunId(ctx.newRunId());
    const script = gateScript({
      workspace: ctx.workspace,
      runId,
      cwd: mapped.cwd,
      envFile: `${ctx.workspace}/env/env.sh`,
      ...(extra.file !== undefined ? { extraEnvFile: extra.file } : {}),
      command,
      args: rewriteEmbeddedHostPaths(args, ctx.hostWorktreePath, `${ctx.workspace}/repo`),
    });
    const tail = stderrTail();
    const callerOutput = gateOpts?.onOutput;
    const opts: RunProcessOptions = {
      ...gateOpts,
      onOutput: (chunk) => {
        tail.push(chunk);
        callerOutput?.(chunk);
      },
    };
    ctx.registry.add(ctx.registryKey, runId);
    try {
      const outcome = await ctx.gateProcess(ctx.sshBin, sshArgv(ctx.remote, ctx.controlDir, script), ctx.hostWorktreePath, opts);
      if (outcome.kind === 'timedOut' || outcome.kind === 'aborted') {
        await killRemoteGate(ctx, runId);
        return outcome;
      }
      if (outcome.kind !== 'completed') return outcome;
      const read = await verdict(ctx, runId, outcome.exitCode, tail.text());
      if (!read.ok) {
        return { kind: 'spawnFailed', message: read.reason, output: outcome.output, ...(outcome.stdout !== undefined ? { stdout: outcome.stdout } : {}), ...(outcome.waitMs !== undefined ? { waitMs: outcome.waitMs } : {}) };
      }
      return { ...outcome, exitCode: read.code };
    } finally {
      ctx.registry.remove(ctx.registryKey, runId);
    }
  };
}
