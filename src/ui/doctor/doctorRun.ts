/**
 * The Doctor panel's `karst doctor --json` call, vscode-free (DR-4).
 *
 * `host.ts` binds it: the CLI entry, the DB path and the manifest path are the
 * session's current values, so they are read on EVERY run. A panel lives longer
 * than one run — a rerun or a reopened tab after a manifest switch must use the
 * new `manifestPath`, not the one captured when the flow was created.
 */
import { execFile } from 'node:child_process';
import type { DoctorReport } from '../../doctor/types.js';
import { runDoctorViaCli, type RunCli } from '../../extension/ops/doctorOps.js';

/** What the session's CLI needs; `manifestPath` is absent for a single-repo session. */
export interface DoctorCliInput {
  cliEntry: string;
  dbPath: string;
  manifestPath?: string;
}

/** `node:child_process`'s `execFile`, narrowed to the shape this module uses. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  callback: (error: unknown, stdout: string, stderr: string) => void,
) => void;

/** The real spawn, with the report-sized buffer a doctor run can need. */
const defaultExec: ExecFileFn = (file, args, callback) => {
  execFile(file, [...args], { maxBuffer: 4 * 1024 * 1024 }, callback);
};

/** Builds the `run` the flow calls; `cli` is invoked per run, never once per panel. */
export function createDoctorRun(
  cli: () => DoctorCliInput,
  exec: ExecFileFn = defaultExec,
): (fix: boolean, only?: readonly string[]) => Promise<DoctorReport> {
  return (fix, only) => {
    const { cliEntry, dbPath, manifestPath } = cli();
    // The CLI spawns git/gh synchronously; the extension host never blocks. The
    // spawn error rides along so a missing binary is not a blank reason (DR-4).
    const runCli: RunCli = (args) =>
      new Promise((resolve) => {
        exec(process.execPath, [cliEntry, ...args], (error, stdout, stderr) =>
          resolve({ stdout, stderr, ...(error ? { error } : {}) }),
        );
      });
    return runDoctorViaCli({ runCli, db: dbPath, ...(manifestPath ? { manifest: manifestPath } : {}) }, fix, only);
  };
}
