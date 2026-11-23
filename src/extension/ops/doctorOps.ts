import type { DoctorReport } from '../../doctor/types.js';
import { reasonText } from '../../model/notifyText.js';

/** Runs the karst CLI and resolves with stdout even when it exits non-zero. */
export type RunCli = (args: readonly string[]) => Promise<{ stdout: string; stderr: string; error?: unknown }>;

export interface DoctorOpsDeps {
  runCli: RunCli;
  db: string;
  manifest?: string;
}

/**
 * Runs `karst doctor --json` out of process (the CLI spawns git/gh
 * synchronously; the extension host must never). `fix` is only true for the
 * panel's explicit "Fix safe issues" click; `only` pins exactly the check ids
 * the confirmation modal listed (`--only <id>` repeated — a check id can hold a
 * repo name, so it is never a comma-separated list).
 */
export async function runDoctorViaCli(
  deps: DoctorOpsDeps,
  fix: boolean,
  only?: readonly string[],
): Promise<DoctorReport> {
  const args = [
    '--db', deps.db,
    ...(deps.manifest ? ['--manifest', deps.manifest] : []),
    'doctor',
    '--json',
    ...(fix ? ['--fix'] : []),
    // An empty `only` flat-maps to no flag, so it needs no length guard: `> 0`
    // and `>= 0` build the same args, and that guard can never be observed.
    ...(fix && only ? only.flatMap((id) => ['--only', id]) : []),
  ];
  const { stdout, stderr, error } = await deps.runCli(args);
  try {
    return JSON.parse(stdout) as DoctorReport;
  } catch {
    // `execFile` reports a spawn failure (missing CLI, EACCES) as `error` with an
    // empty stderr; never drop it and leave the panel with a blank reason (DR-4).
    const detail = stderr.trim().slice(0, 500) || (error !== undefined ? reasonText(error) : '');
    throw new Error(`karst doctor produced no report${detail ? `: ${detail}` : ''}`);
  }
}
