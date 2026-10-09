import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

/**
 * Real machine probes for `karst doctor`. This runs in the short-lived CLI
 * process, never the extension host, so synchronous spawns are fine here (the
 * `spawnSync` ban is for gate paths in the host). Every probe is read-only and
 * never throws.
 */

function run(cmd: string, args: readonly string[], cwd?: string): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', cwd, timeout: 15000 });
    return { ok: !r.error && r.status === 0, out: (r.stdout ?? '').trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

export const pathExists = (p: string): boolean => existsSync(p);

export function isGitRepo(p: string): boolean {
  return run('git', ['-C', p, 'rev-parse', '--git-dir']).ok;
}

export function branchExists(repo: string, branch: string): boolean {
  return run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

export function binaryResolves(command: string): boolean {
  if (command.includes('/')) return existsSync(command);
  return run(process.platform === 'win32' ? 'where' : 'which', [command]).ok;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Process start time (epoch ms) via `ps`, or undefined when unknowable. */
export function pidStartedAtMs(pid: number): number | undefined {
  const r = run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (!r.ok || r.out === '') return undefined;
  const ms = Date.parse(r.out);
  return Number.isNaN(ms) ? undefined : ms;
}

/** 'clean' only when nothing is uncommitted AND nothing is unpushed. */
export function worktreeState(path: string): 'clean' | 'dirty' | 'unknown' {
  if (!existsSync(path)) return 'unknown';
  const status = run('git', ['-C', path, 'status', '--porcelain']);
  if (!status.ok) return 'unknown';
  if (status.out !== '') return 'dirty';
  const ahead = run('git', ['-C', path, 'rev-list', '--count', '@{u}..HEAD']);
  if (!ahead.ok) return 'unknown'; // no upstream: cannot prove it is pushed
  return ahead.out === '0' ? 'clean' : 'dirty';
}

/** Pids listening on `port` (empty when free or lsof is unavailable). */
export function listeningPids(port: number): number[] {
  const r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return r.out
    .split('\n')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function fileBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export function toolVersion(binary: string): string | undefined {
  const r = run(binary, ['--version']);
  return r.ok ? r.out : undefined;
}
