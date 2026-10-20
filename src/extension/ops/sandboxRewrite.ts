import type { ProcessResult, SbxProcess } from '../../agent/sbx/sbxProcess.js';

/** Runs host git in `cwd`; a non-zero code is a result, never a throw. */
export type GitRun = (cwd: string, args: readonly string[]) => Promise<ProcessResult>;

export const nodeGit = (proc: SbxProcess): GitRun => (cwd, args) => proc.run('git', ['-C', cwd, ...args]);

export type Divergence =
  | { readonly kind: 'rewritten'; readonly recorded: string; readonly cloneHead: string }
  | { readonly kind: 'diverged' };

export interface ClassifyInput {
  readonly worktree: string;
  readonly branch: string;
  /** Host branch head recorded at the last successful sync; undefined → try the host reflog. */
  readonly recorded: string | undefined;
}

const isAncestor = async (run: GitRun, cwd: string, a: string, b: string): Promise<boolean> =>
  (await run(cwd, ['merge-base', '--is-ancestor', a, b])).code === 0;

async function revParse(run: GitRun, cwd: string, rev: string): Promise<string | undefined> {
  const r = await run(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function reflogHeads(run: GitRun, input: ClassifyInput): Promise<string[]> {
  const r = await run(input.worktree, ['reflog', 'show', '--format=%H', `refs/heads/${input.branch}`]);
  return r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

/**
 * Why a sync was refused as not-a-fast-forward, once the clone's branch sits in
 * FETCH_HEAD of the host worktree. 'rewritten' only when the old host head is
 * provably in the clone and no longer in the host branch (a rebase/amend);
 * anything else is true divergence and stays refused (arch:AC-33).
 */
export async function classifyDivergence(run: GitRun, input: ClassifyInput): Promise<Divergence> {
  const cloneHead = await revParse(run, input.worktree, 'FETCH_HEAD');
  const hostHead = await revParse(run, input.worktree, 'HEAD');
  if (!cloneHead || !hostHead) return { kind: 'diverged' };
  const candidates = input.recorded ? [input.recorded] : await reflogHeads(run, input);
  for (const candidate of candidates) {
    if (candidate === cloneHead || candidate === hostHead) continue;
    if ((await isAncestor(run, input.worktree, candidate, cloneHead)) && !(await isAncestor(run, input.worktree, candidate, hostHead))) {
      return { kind: 'rewritten', recorded: candidate, cloneHead };
    }
  }
  return { kind: 'diverged' };
}
