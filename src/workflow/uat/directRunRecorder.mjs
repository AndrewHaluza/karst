#!/usr/bin/env node
/**
 * The UAT direct-run recorder (@arch:UAT-OBS-RUNS).
 *
 *   node directRunRecorder.mjs --name <name> [--run <run id>] -- <command...>
 *
 * Runs the command (no shell) from the current directory, and writes
 * `.karst/uat-scratch/out/direct/<name>/summary.json` with the command, the exit
 * code, the start and end time, the run id and the stdout/stderr tails. Exits
 * with the command's exit code. It ships next to `harnessRunner.mjs`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUT_ROOT, runCommand } from './harnessRunner.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const DIRECT_DIR = 'direct';

export function parseArgs(argv) {
  const sep = argv.indexOf('--');
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  const command = sep === -1 ? [] : argv.slice(sep + 1);
  const out = { name: undefined, run: undefined, command };
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i];
    if (key !== '--name' && key !== '--run') throw new Error(`unknown argument: ${key}`);
    const value = flags[i + 1];
    if (value === undefined) throw new Error(`${key} needs a value`);
    out[key.slice(2)] = value;
  }
  if (out.name === undefined || !NAME.test(out.name)) throw new Error(`--name must match ${NAME.source}`);
  if (out.run !== undefined && !RUN_ID.test(out.run)) throw new Error(`--run must match ${RUN_ID.source}`);
  if (command.length === 0) throw new Error('a command is required after "--"');
  return out;
}

export async function main(argv, cwd = process.cwd()) {
  const args = parseArgs(argv);
  const startedAt = new Date().toISOString();
  const result = await runCommand(args.command, cwd);
  const dir = join(cwd, OUT_ROOT, DIRECT_DIR, args.name);
  await mkdir(dir, { recursive: true });
  const summary = {
    kind: 'direct-run',
    name: args.name,
    runId: args.run ?? null,
    command: args.command,
    exitCode: result.exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    stdoutTail: result.stdout,
    stderrTail: result.stderr,
  };
  await writeFile(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return result.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`uat-direct-run: ${error.message}\n`);
      process.exit(2);
    },
  );
}
