import type { RemoteDef } from '../../manifest/types.js';
import type { GateOutputChunk, GateProcessRunner, ProcessOutcome, RunProcessOptions } from '../../workflow/gates/run.js';
import { DOCKER_BIN } from '../docker/dockerPreflight.js';
import { dockerRemoteCommand } from './sshDockerProcess.js';
import { assertRunId, readExitScript, verdictFromExitFile, verdictFromStderr } from './sshGateScript.js';
import { sshArgv, type SshProcess } from './sshProcess.js';
import { confirmRecord } from './sshRunGate.js';
import { sshQuote } from './sshQuote.js';

/**
 * `runGate` of the ssh docker runner (D822, edit 10; `@arch:STAGEMACH`).
 *
 * `createDockerSessionRunner` calls its `gateProcess` with `docker exec …` (or a
 * one-shot `docker run …`) and expects the verdict as a process exit. In this
 * mode that docker client runs on the REMOTE, so the gate is one ssh command
 * whose remote script is:
 *
 * 1. run the docker argv (the container work happens on the remote daemon);
 * 2. record `<runId>:<rc>` in `<ws>/gates/<runId>.exit` (mode 0600, OUTSIDE the
 *    container: no `<ws>/gates` bind mount ever reaches it);
 * 3. print `KARST_GATE_EXIT=<runId>:<rc>` on stderr as the fallback;
 * 4. exit with the docker client's rc.
 *
 * The verdict is read back with a second ssh call — exactly the D555 rule
 * (`sshGateScript.ts`): only a record that the local ssh exit confirms counts
 * (`confirmRecord`), so a process the gate leaves behind cannot forge one, and
 * a transport drop (255 with no record) is no verdict at all.
 *
 * For a genuine exit 255 WITH more than 1 MiB of gate output, the bounded
 * `output` keeps only the head, so the stderr marker is captured from a
 * bounded 64 KiB tail of the live stream instead (`onOutput`).
 */

/** The stderr tail kept for the marker fallback (the bounded `output` keeps only the head). */
const STDERR_TAIL_BYTES = 64 * 1024;

/** The bound for the small remote reads (the exit file). */
const SMALL_STDOUT_BYTES = 4 * 1024;

/** The bound of the exit-file read; it is one short remote command. */
const READ_TIMEOUT_MS = 60_000;

export interface SshDockerGateContext {
  readonly ssh: SshProcess;
  /** The ssh executable the host gate boundary spawns; `SSH_BIN` in production. */
  readonly sshBin: string;
  readonly remote: RemoteDef;
  /** The manifest name of the remote; every reason names it (`ssh <name>: …`). */
  readonly remoteName: string;
  readonly controlDir: string;
  /** `<remoteDir>/<name>`: the gate records live in `<workspace>/gates`. */
  readonly workspace: string;
  /** The host worktree the ssh client runs in (a cwd for the local process only). */
  readonly hostWorktreePath: string;
  /** Host-made hex run id; also the exit-file name. */
  readonly newRunId: () => string;
  /** The host gate boundary (default `runProcess`). */
  readonly gateProcess: GateProcessRunner;
  readonly debug?: (message: string) => void;
}

/** The remote script of one docker gate: the docker argv, then the two records. */
export function sshDockerGateScript(workspace: string, runId: string, dockerArgs: readonly string[]): string {
  const gates = `${workspace}/gates`;
  const exitFile = `${gates}/${runId}.exit`;
  return [
    '# karst-ssh-docker-gate',
    `mkdir -p -m 700 ${sshQuote(gates)}`,
    dockerRemoteCommand(dockerArgs),
    'rc=$?',
    `(umask 077; printf '%s:%s\\n' ${sshQuote(runId)} "$rc" > ${sshQuote(exitFile)})`,
    `printf '\\nKARST_GATE_EXIT=%s:%s\\n' ${sshQuote(runId)} "$rc" >&2`,
    'exit $rc',
  ].join('\n');
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

type Verdict = { readonly ok: true; readonly code: number } | { readonly ok: false; readonly reason: string };

/**
 * The verdict after the local ssh client finished: the exit file first, the
 * stderr marker only when it is missing or unreadable; each checked against the
 * local exit code.
 */
async function readVerdict(ctx: SshDockerGateContext, runId: string, localCode: number, stderr: string): Promise<Verdict> {
  const read = await ctx.ssh
    .run(sshArgv(ctx.remote, ctx.controlDir, readExitScript(ctx.workspace, runId)), {
      maxStdoutBytes: SMALL_STDOUT_BYTES,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    .catch(() => undefined);
  if (read !== undefined && read.transport !== true && read.code === 0) {
    const fromFile = verdictFromExitFile(read.stdout, runId);
    if (fromFile !== undefined) return confirmRecord(ctx.remoteName, fromFile, localCode);
    ctx.debug?.(`[ssh ${ctx.remoteName}] docker gate ${runId}: exit file unreadable, using the stderr marker`);
  }
  const fromStderr = verdictFromStderr(stderr, runId);
  if (fromStderr !== undefined) return confirmRecord(ctx.remoteName, fromStderr, localCode);
  const tail = lastLine(stderr);
  if (localCode === 255) {
    return { ok: false, reason: `ssh transport failed${tail === '' ? '' : `: ${tail}`}` };
  }
  return {
    ok: false,
    reason: `ssh ${ctx.remoteName}: the docker gate left no exit record (ssh exit ${String(localCode)})${tail === '' ? '' : `: ${tail}`}`,
  };
}

export function sshDockerGateProcess(ctx: SshDockerGateContext): GateProcessRunner {
  return async (command, args, cwd, gateOpts?: RunProcessOptions): Promise<ProcessOutcome> => {
    if (command !== DOCKER_BIN) {
      return { kind: 'spawnFailed', message: `ssh docker gate: refusing non-docker command ${JSON.stringify(command)}`, output: '' };
    }
    const runId = assertRunId(ctx.newRunId());
    const script = sshDockerGateScript(ctx.workspace, runId, args);
    const tail = stderrTail();
    const callerOutput = gateOpts?.onOutput;
    const opts: RunProcessOptions = {
      ...gateOpts,
      onOutput: (chunk) => {
        tail.push(chunk);
        callerOutput?.(chunk);
      },
    };
    const outcome = await ctx.gateProcess(ctx.sshBin, sshArgv(ctx.remote, ctx.controlDir, script), ctx.hostWorktreePath, opts);
    // A timeout or an abort already killed the in-container process through
    // `createDockerSessionRunner` (`opts.proc` is `sshDockerProcess`); there is
    // no verdict to read.
    if (outcome.kind !== 'completed') return outcome;
    const verdict = await readVerdict(ctx, runId, outcome.exitCode, tail.text());
    if (!verdict.ok) {
      return {
        kind: 'spawnFailed',
        message: verdict.reason,
        output: outcome.output,
        ...(outcome.stdout !== undefined ? { stdout: outcome.stdout } : {}),
        ...(outcome.waitMs !== undefined ? { waitMs: outcome.waitMs } : {}),
      };
    }
    return { ...outcome, exitCode: verdict.code };
  };
}
