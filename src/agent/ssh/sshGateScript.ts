import { sshQuote } from './sshQuote.js';

/**
 * The remote gate scripts of the ssh runner (D555, edit 6; `@arch:STAGEMACH`).
 *
 * A gate verdict decides a stage transition, so the rule is strict and in one
 * place:
 *
 * 1. The remote script writes `<runId>:<rc>` to `<ws>/gates/<runId>.exit`
 *    (mode 0600) and prints `KARST_GATE_EXIT=<runId>:<rc>` on stderr.
 * 2. The host reads the exit file with a second ssh call and accepts ONLY a
 *    content of exactly `<its runId>:<digits>` (`verdictFromExitFile`).
 * 3. Only when the exit file is missing or unreadable, the LAST stderr line
 *    `KARST_GATE_EXIT=<its runId>:<digits>` is the fallback
 *    (`verdictFromStderr`). A line with another run id is ignored. A marker
 *    with the own run id is checked by rule 5.
 * 4. Neither source: no verdict. The local ssh exit code is never a verdict
 *    by itself (255 is a transport failure OR a real gate exit).
 * 5. A record counts only when the local ssh exit code agrees with it
 *    (`confirmRecord` in `sshRunGate.ts`). A process that the gate leaves
 *    behind runs as the same user: it can rewrite the exit file or print a
 *    late marker with the right run id. It cannot change the exit status that
 *    sshd sends for the wrapper's `exit $rc`. A disagreement is no verdict.
 *
 * The run id is host-made (hex); the pgid that a kill uses is read from the
 * pgid file, and the remote script accepts it only when it is all digits and
 * greater than 1: `kill -- -1` would signal every process of the user.
 */

/** A host-made run id: hex only, so it is safe in a file name and a regex. */
export const GATE_RUN_ID_RE = /^[0-9a-f]{8,64}$/;

export interface GatePaths {
  /** `<ws>/gates` */
  readonly gatesDir: string;
  /** `<ws>/gates/<runId>.exit` */
  readonly exitFile: string;
  /** `<ws>/gate-<runId>.pgid` */
  readonly pgidFile: string;
  /** `<ws>/gate-<runId>.owner`: the pid of the gate wrapper (the remote `sh` that waits for the group). */
  readonly ownerFile: string;
}

export function assertRunId(runId: string): string {
  if (!GATE_RUN_ID_RE.test(runId)) throw new Error(`ssh gate: invalid run id ${JSON.stringify(runId)}`);
  return runId;
}

export function gatePaths(workspace: string, runId: string): GatePaths {
  assertRunId(runId);
  return {
    gatesDir: `${workspace}/gates`,
    exitFile: `${workspace}/gates/${runId}.exit`,
    pgidFile: `${workspace}/gate-${runId}.pgid`,
    ownerFile: `${workspace}/gate-${runId}.owner`,
  };
}

export interface GateScriptInput {
  readonly workspace: string;
  readonly runId: string;
  /** The remote cwd (already mapped to `<ws>/repo[/sub]`). */
  readonly cwd: string;
  /** The remote env file (`<ws>/env/env.sh`). */
  readonly envFile: string;
  readonly command: string;
  /** Already mapped to the remote paths. */
  readonly args: readonly string[];
}

/**
 * The remote gate script (run under `remoteSh` by the caller). The `( … )`
 * keeps the spec's chain but makes a failed `cd` or `.` of a missing env file
 * an rc, not an exit of the whole shell, so the exit file is always written.
 * `setsid -w` returns the gate's exit code; its child writes its own pid, which
 * is the new process group id, to the pgid file. The wrapper writes its own
 * pid to the owner file first, so the sweep can tell a live gate of another
 * window from an orphan. The `trap` removes both files when the wrapper exits.
 */
export function gateScript(input: GateScriptInput): string {
  const paths = gatePaths(input.workspace, input.runId);
  const runId = sshQuote(input.runId);
  const inner = [input.command, ...input.args].map(sshQuote).join(' ');
  return [
    '# karst-ssh-gate',
    `mkdir -p -m 700 ${sshQuote(paths.gatesDir)}`,
    `trap ${sshQuote(`rm -f ${sshQuote(paths.pgidFile)} ${sshQuote(paths.ownerFile)}`)} EXIT`,
    `echo $$ > ${sshQuote(paths.ownerFile)}`,
    `(cd ${sshQuote(input.cwd)} && . ${sshQuote(input.envFile)} && export KARST_SANDBOX=1 && ` +
      `setsid -w sh -c 'echo $$ > "$2"; exec sh -c "$1"' _ ${sshQuote(inner)} ${sshQuote(paths.pgidFile)})`,
    'rc=$?',
    `(umask 077; printf '%s:%s\\n' ${runId} "$rc" > ${sshQuote(paths.exitFile)})`,
    `printf '\\nKARST_GATE_EXIT=%s:%s\\n' ${runId} "$rc" >&2`,
    'exit $rc',
  ].join('\n');
}

/** Exit code of `readExitScript` when the exit file does not exist. */
export const EXIT_FILE_MISSING = 3;

/** Print the exit file, then remove it. A missing file exits `EXIT_FILE_MISSING`. */
export function readExitScript(workspace: string, runId: string): string {
  const { exitFile } = gatePaths(workspace, runId);
  return [
    '# karst-ssh-gate-exit',
    `f=${sshQuote(exitFile)}`,
    `if [ -f "$f" ]; then cat -- "$f"; rc=$?; rm -f -- "$f"; exit $rc; fi`,
    `exit ${String(EXIT_FILE_MISSING)}`,
  ].join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The exit code in the exit file, or `undefined` when its content is not exactly `<runId>:<digits>`. */
export function verdictFromExitFile(content: string, runId: string): number | undefined {
  const match = new RegExp(`^${escapeRegExp(runId)}:(\\d{1,3})$`).exec(content.trim());
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

/** The code of the LAST stderr line `KARST_GATE_EXIT=<runId>:<digits>`; lines of another run id are ignored. */
export function verdictFromStderr(stderr: string, runId: string): number | undefined {
  const line = new RegExp(`^KARST_GATE_EXIT=${escapeRegExp(runId)}:(\\d{1,3})$`);
  let verdict: number | undefined;
  for (const raw of stderr.split('\n')) {
    const match = line.exec(raw.replace(/\r$/, ''));
    if (match) verdict = Number.parseInt(match[1]!, 10);
  }
  return verdict;
}

/** The remote check that a pgid read from a file is all digits and > 1 (never `kill -- -1`). */
const PGID_OK = `case "$p" in ''|*[!0-9]*) p='' ;; esac; if [ -n "$p" ] && [ "$p" -le 1 ]; then p=''; fi`;

/** Print the pgid of a live gate (empty when its file is gone or holds no valid pgid). */
export function readPgidScript(workspace: string, runId: string): string {
  const { pgidFile } = gatePaths(workspace, runId);
  return [
    '# karst-ssh-gate-pgid',
    `f=${sshQuote(pgidFile)}`,
    'p=$(cat -- "$f" 2>/dev/null)',
    PGID_OK,
    `printf '%s' "$p"`,
  ].join('\n');
}

/** A pgid the host read back: digits and > 1, else `undefined`. */
export function parsePgid(stdout: string): number | undefined {
  const text = stdout.trim();
  if (!/^\d{1,10}$/.test(text)) return undefined;
  const pgid = Number.parseInt(text, 10);
  return pgid > 1 ? pgid : undefined;
}

/** Seconds the kill script waits for a group to go after KILL. */
const KILL_SETTLE_SECONDS = 5;

/**
 * Kill one remote gate group: TERM, then KILL after `graceSeconds`, each only
 * while the pgid file still exists (the wrapper's `trap` removes it once the
 * group is gone, so a reused pid is never signalled). Then remove the pgid file
 * and the exit file: a killed gate has no verdict.
 *
 * The group operand is `-<pgid>` with no `--`: the dash `kill` builtin (the
 * `/bin/sh` of Debian and Ubuntu) rejects `--` ("Illegal number"), so
 * `kill -TERM -- -<pgid>` signals nothing there. When the group is still alive
 * after KILL, the script keeps the pgid file (the sweep tries again) and exits 1.
 */
export function killGateScript(workspace: string, runId: string, pgid: number, graceSeconds: number): string {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`ssh gate: invalid pgid ${String(pgid)}`);
  if (!Number.isInteger(graceSeconds) || graceSeconds < 0) throw new Error(`ssh gate: invalid grace ${String(graceSeconds)}`);
  const paths = gatePaths(workspace, runId);
  const group = `-${String(pgid)}`;
  return [
    '# karst-ssh-gate-kill',
    `f=${sshQuote(paths.pgidFile)}`,
    `alive() { [ -f "$f" ] && kill -0 ${group} 2>/dev/null; }`,
    `if [ -f "$f" ]; then kill -TERM ${group} 2>/dev/null; fi`,
    `i=0; while alive && [ "$i" -lt ${String(graceSeconds)} ]; do sleep 1; i=$((i+1)); done`,
    `if [ -f "$f" ]; then kill -KILL ${group} 2>/dev/null; fi`,
    `i=0; while alive && [ "$i" -lt ${String(KILL_SETTLE_SECONDS)} ]; do sleep 1; i=$((i+1)); done`,
    `if alive; then echo ${sshQuote(`ssh gate: group ${group} is still alive after KILL`)} >&2; exit 1; fi`,
    `rm -f -- "$f" ${sshQuote(paths.ownerFile)} ${sshQuote(paths.exitFile)}`,
  ].join('\n');
}

/**
 * The orphan sweep (session start and reattach): kill every gate group whose
 * pgid file is in `<ws>`, whose run id is NOT live in this window's registry,
 * and whose wrapper is dead. Two windows can share one ssh sandbox, and the
 * registry knows only this window: a live wrapper pid in the owner file marks
 * a gate that another window still waits for, so the sweep keeps it. A reused
 * pid only keeps a group, it never kills one. The live ids arrive as positional
 * parameters (`set -- …`), never as script text; a file name whose run id is
 * not hex is skipped.
 */
export function sweepScript(workspace: string, liveRunIds: readonly string[]): string {
  const live = liveRunIds.map(assertRunId);
  return [
    '# karst-ssh-gate-sweep',
    live.length === 0 ? 'set --' : `set -- ${live.map(sshQuote).join(' ')}`,
    `ws=${sshQuote(workspace)}`,
    'for f in "$ws"/gate-*.pgid; do',
    '  [ -f "$f" ] || continue',
    '  id=${f##*/gate-}; id=${id%.pgid}',
    `  case "$id" in ''|*[!0-9a-f]*) continue ;; esac`,
    '  skip=0; for l in "$@"; do [ "$l" = "$id" ] && skip=1; done',
    '  [ "$skip" = 1 ] && continue',
    '  o=$(cat -- "$ws/gate-$id.owner" 2>/dev/null)',
    `  case "$o" in ''|*[!0-9]*) o='' ;; esac`,
    '  if [ -n "$o" ] && kill -0 "$o" 2>/dev/null; then continue; fi',
    '  p=$(cat -- "$f" 2>/dev/null)',
    `  ${PGID_OK}`,
    '  if [ -n "$p" ]; then kill -KILL "-$p" 2>/dev/null; fi',
    '  rm -f -- "$f" "$ws/gate-$id.owner" "$ws/gates/$id.exit"',
    'done',
    'exit 0',
  ].join('\n');
}
