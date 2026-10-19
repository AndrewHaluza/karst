import { existsSync, readFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { PlacedInteractiveLaunch } from './sessionRunner.js';

/** A launch that dies inside this window, non-zero, never started (arch:AC-32). */
export const FAST_FAIL_SECONDS = 10;
/** Only the last bytes of the launcher's stderr are kept and shown. */
export const TAIL_BYTES = 4096;

export interface CaptureFiles {
  /** The launcher's stderr, teed. */
  readonly stderr: string;
  /** Written (with the exit code) only when the launch failed fast. */
  readonly fast: string;
}

export function captureFilesFor(dir: string, ticketId: number): CaptureFiles {
  return {
    stderr: join(dir, `sandbox-launch-${ticketId}.stderr`),
    fast: join(dir, `sandbox-launch-${ticketId}.fast`),
  };
}

// $1 stderr file, $2 fast-fail marker, rest: the launcher. stderr is teed (still
// reaches the terminal); on a fast non-zero exit the terminal stays open with a
// hint until Enter, so the output does not vanish with the tab.
const SCRIPT = [
  'f=$1; m=$2; shift 2',
  '"$@" 2> >(tee "$f" >&2); rc=$?',
  `if [ "$rc" -ne 0 ] && [ "$SECONDS" -lt ${FAST_FAIL_SECONDS} ]; then`,
  '  printf "%s\\n" "$rc" > "$m"',
  '  printf "\\nkarst: sandbox launch failed (exit %s). Retry, or set agentBackends.<core>=host. Press Enter to close.\\n" "$rc" >&2',
  '  read -r _',
  'fi',
  'exit "$rc"',
].join('\n');

/** Run the placed launch under bash so its stderr is kept; the tty is untouched. */
export function wrapWithStderrCapture(
  placed: PlacedInteractiveLaunch,
  files: CaptureFiles,
): PlacedInteractiveLaunch {
  return {
    ...placed,
    shellPath: '/bin/bash',
    shellArgs: ['-c', SCRIPT, 'karst-launch', files.stderr, files.fast, placed.shellPath, ...placed.shellArgs],
  };
}

export interface LaunchFailure {
  readonly exitCode: number;
  readonly tail: string;
}

function readTail(path: string): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const len = Math.min(size, TAIL_BYTES);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Reads the capture, then deletes both files. Null when the launch did not fail fast. */
export function readLaunchFailure(files: CaptureFiles): LaunchFailure | null {
  try {
    if (!existsSync(files.fast)) return null;
    const exitCode = Number.parseInt(readFileSync(files.fast, 'utf8').trim(), 10);
    return { exitCode: Number.isNaN(exitCode) ? 1 : exitCode, tail: readTail(files.stderr) };
  } finally {
    rmSync(files.stderr, { force: true });
    rmSync(files.fast, { force: true });
  }
}

/** Untrusted CLI text is shown as flattened text, never parsed. */
export function formatLaunchFailure(ticketLabel: string, kind: string, f: LaunchFailure): string {
  const text = f.tail.replace(/\s+/g, ' ').trim() || '(no output captured)';
  return `[session] ticket ${ticketLabel} sandbox launch failed (runner: ${kind}, exit ${f.exitCode}): ${text}`;
}
