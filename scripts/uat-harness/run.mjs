#!/usr/bin/env node
/**
 * The UAT harness evidence runner (@arch:UAT-HARNESS).
 *
 *   node scripts/uat-harness/run.mjs --harness <name> --check <id> -- <command...>
 *
 * Runs the command (no shell) from the current directory, and writes
 * `.karst/uat-scratch/out/<harness>/<check>/summary.json` with the command, the
 * exit code and the stdout/stderr tails. Exits with the command's exit code.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAIL_CHARS = 4000;
export const OUT_ROOT = join('.karst', 'uat-scratch', 'out');

export function parseArgs(argv) {
  const sep = argv.indexOf('--');
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  const command = sep === -1 ? [] : argv.slice(sep + 1);
  const out = { harness: undefined, check: undefined, command };
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i];
    if (key !== '--harness' && key !== '--check') throw new Error(`unknown argument: ${key}`);
    const value = flags[i + 1];
    if (value === undefined) throw new Error(`${key} needs a value`);
    out[key.slice(2)] = value;
  }
  for (const key of ['harness', 'check']) {
    if (out[key] === undefined || !NAME.test(out[key])) throw new Error(`--${key} must match ${NAME.source}`);
  }
  if (command.length === 0) throw new Error('a command is required after "--"');
  return out;
}

const tail = (text) => (text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text);

export function runCommand(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout = tail(stdout + c); process.stdout.write(c); });
    child.stderr.on('data', (c) => { stderr = tail(stderr + c); process.stderr.write(c); });
    child.on('error', (error) => resolve({ exitCode: 127, stdout, stderr: tail(`${stderr}${error.message}`) }));
    child.on('close', (code, signal) => resolve({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

export async function main(argv, cwd = process.cwd()) {
  const args = parseArgs(argv);
  const startedAt = new Date().toISOString();
  const result = await runCommand(args.command, cwd);
  const dir = join(cwd, OUT_ROOT, args.harness, args.check);
  await mkdir(dir, { recursive: true });
  const summary = {
    harness: args.harness,
    check: args.check,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`uat-harness: ${error.message}\n`);
      process.exit(2);
    },
  );
}
