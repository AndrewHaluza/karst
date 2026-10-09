import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanningManifest, PlanningRepoHistory } from '../../planning/preamble.js';
import { PLANNING_HISTORY_MAX_COMMITS } from '../../planning/preamble.js';

/** One commit line's cap in the snapshot. */
const COMMIT_LINE_MAX = 90;
const ARCH_DIR = join('docs', 'arch');
const ARCH_KEY = /^## \[@arch:([^\]]+)\]/;
const GIT_TIMEOUT_MS = 5_000;

export interface PlanningHistoryDeps {
  /** Runs `git <args>` and resolves its stdout; rejects on a non-zero exit. */
  runGit: (args: string[]) => Promise<string>;
  debug?: (message: string) => void;
}

/** The real async runner (never spawnSync: this runs in the extension host). */
export function execGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function recentCommits(repoPath: string, base: string, deps: PlanningHistoryDeps): Promise<string[]> {
  try {
    // The trailing `--` keeps a base named like a file (this repo has `develop`) a revision.
    const out = await deps.runGit(['-C', repoPath, 'log', '--oneline', `-${PLANNING_HISTORY_MAX_COMMITS}`, base, '--']);
    return out.split('\n').filter((l) => l.length > 0).map((l) => l.slice(0, COMMIT_LINE_MAX));
  } catch (err) {
    deps.debug?.(`[planning] history: git log ${base} in ${repoPath} failed — commits omitted: ${message(err)}`);
    return [];
  }
}

async function archKeys(repoPath: string, deps: PlanningHistoryDeps): Promise<PlanningRepoHistory['archKeys']> {
  const dir = join(repoPath, ARCH_DIR);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    const entries = await Promise.all(
      files.map(async (file) => {
        const lines = (await readFile(join(dir, file), 'utf8')).split('\n');
        const keys = lines.flatMap((l) => ARCH_KEY.exec(l)?.[1] ?? []);
        return { file, keys };
      }),
    );
    return entries.filter((e) => e.keys.length > 0);
  } catch (err) {
    deps.debug?.(`[planning] history: no docs/arch keys in ${repoPath} — omitted: ${message(err)}`);
    return [];
  }
}

/** One snapshot per distinct enabled repoPath (a monorepo's repos share one), in manifest order. */
export async function gatherPlanningHistory(
  manifest: PlanningManifest,
  deps: PlanningHistoryDeps,
): Promise<PlanningRepoHistory[]> {
  const seen = new Set<string>();
  const targets = Object.entries(manifest.repositories)
    .filter(([, def]) => def.enabled !== false)
    .filter(([, def]) => !seen.has(def.repoPath) && Boolean(seen.add(def.repoPath)));
  return Promise.all(
    targets.map(async ([repo, def]) => {
      const base = def.baselineBranch ?? manifest.baselineBranch;
      const [commits, keys] = await Promise.all([recentCommits(def.repoPath, base, deps), archKeys(def.repoPath, deps)]);
      return { repo, base, commits, archKeys: keys };
    }),
  );
}
