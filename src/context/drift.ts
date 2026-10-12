import { execFileSync } from 'node:child_process';
import type { TicketContext } from './ticketContext.js';

export function parseCodePointerPaths(rawPointers: string | null | undefined): string[] {
  if (!rawPointers) return [];
  const paths: string[] = [];
  for (const line of rawPointers.split('\n')) {
    const m = line.trim().match(/^- (\S+?)(?::\d+)? —/);
    if (m?.[1] && !paths.includes(m[1])) {
      paths.push(m[1]);
    }
  }
  return paths;
}

/** Worktrees are keyed by repoPath, base shas by manifest name: match through the repo list. */
export function sharedBaseSha(ctx: Pick<TicketContext, 'repos' | 'baseShas'>, worktreeRepo: string): string | undefined {
  const entry = ctx.repos.find((r) => r.repoPath === worktreeRepo && ctx.baseShas[r.name]);
  return entry ? ctx.baseShas[entry.name] : undefined;
}

export function computeDriftNote(
  worktreePath: string,
  baseSha: string | undefined,
  baseRef: string | null,
  codePointerPaths: string[],
  debug?: (msg: string) => void,
  runGit: (args: string[], cwd: string) => string = (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }),
): string | undefined {
  if (!baseSha || !baseSha.trim()) return undefined;
  const targetBase = baseRef?.trim() || 'HEAD';
  try {
    const countOut = runGit(['rev-list', '--count', `${baseSha}..${targetBase}`], worktreePath).trim();
    const count = parseInt(countOut, 10);
    if (isNaN(count) || count <= 0) return undefined;

    const shortSha = baseSha.slice(0, 8);
    const prefix = `Planned against ${shortSha}; ${targetBase} has moved ${count} commit${count === 1 ? '' : 's'} since`;

    if (codePointerPaths.length === 0) {
      return prefix;
    }

    const mOut = runGit(
      ['rev-list', '--count', `${baseSha}..${targetBase}`, '--', ...codePointerPaths],
      worktreePath,
    ).trim();
    const mCount = parseInt(mOut, 10);
    if (isNaN(mCount) || mCount <= 0) {
      return prefix;
    }

    const logOut = runGit(
      ['log', '-n', '5', '--format=%h %s', `${baseSha}..${targetBase}`, '--', ...codePointerPaths],
      worktreePath,
    ).trim();
    const commits = logOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const commitList = commits.join(', ');

    return `${prefix}; ${mCount} touch files this ticket names: ${commitList}`;
  } catch (e) {
    debug?.(`[context:drift] git failed for ${worktreePath}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
