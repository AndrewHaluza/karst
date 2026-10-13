import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
  return resolveCommand(command) !== undefined;
}

/**
 * The path `which`/`where` reports for `command` (first line), or undefined
 * when it does not resolve. An absolute/relative path with a separator is only
 * checked for existence — never run.
 */
export function resolveCommand(command: string): string | undefined {
  if (command.includes('/')) return existsSync(command) ? command : undefined;
  const r = run(process.platform === 'win32' ? 'where' : 'which', [command]);
  if (!r.ok) return undefined;
  return r.out.split('\n').map((l) => l.trim()).find((l) => l !== '');
}

/** Resolves symlinks (`realpathSync`); undefined when the path cannot be read. */
export function realpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** True when the directory entry exists (`lstat`), even as a dangling symlink. */
export function linkExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A symlink's raw target (`readlinkSync`); undefined when `p` is not a symlink. */
export function readLink(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
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

export function maxUserWatches(procSysPath: string = '/proc/sys/fs/inotify/max_user_watches'): number | undefined {
  try {
    const content = readFileSync(procSysPath, 'utf8').trim();
    const val = parseInt(content, 10);
    return Number.isFinite(val) ? val : undefined;
  } catch {
    return undefined;
  }
}

export function countInotifyWatches(pid: number, fdinfoDir?: string): number | undefined {
  const dir = fdinfoDir ?? `/proc/${pid}/fdinfo`;
  try {
    const entries = readdirSync(dir);
    let total = 0;
    for (const entry of entries) {
      try {
        const content = readFileSync(join(dir, entry), 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.startsWith('inotify wd:')) {
            total++;
          }
        }
      } catch {
        // fd might have closed while reading; ignore
      }
    }
    return total;
  } catch {
    return undefined;
  }
}

