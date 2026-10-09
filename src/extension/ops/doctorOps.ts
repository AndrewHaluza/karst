import type { DoctorReport } from '../../doctor/types.js';

/** Runs the karst CLI and resolves with stdout even when it exits non-zero. */
export type RunCli = (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export interface DoctorOpsDeps {
  runCli: RunCli;
  db: string;
  manifest?: string;
}

/**
 * Runs `karst doctor --json` out of process (the CLI spawns git/gh
 * synchronously; the extension host must never). `fix` is only true for the
 * panel's explicit "Fix safe issues" click.
 */
export async function runDoctorViaCli(deps: DoctorOpsDeps, fix: boolean): Promise<DoctorReport> {
  const args = ['--db', deps.db, ...(deps.manifest ? ['--manifest', deps.manifest] : []), 'doctor', '--json', ...(fix ? ['--fix'] : [])];
  const { stdout, stderr } = await deps.runCli(args);
  try {
    return JSON.parse(stdout) as DoctorReport;
  } catch {
    throw new Error(`karst doctor produced no report${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`);
  }
}
