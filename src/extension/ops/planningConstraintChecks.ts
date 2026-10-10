import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_SENSITIVE_PATHS } from '../../planning/proposal.js';

/**
 * Host-side checks of a draft's `constraints` at ingest. They only ever produce
 * WARNINGS (shown on the card and review page); a check that cannot run is
 * skipped with a debug line, never turned into a rejection.
 */

const ARCH_CONSTRAINT = /^@arch:([A-Z0-9_-]+)$/;
const COMMIT_CONSTRAINT = /^[0-9a-f]{7,40}$/;
const ARCH_DIR = join('docs', 'arch');

type Debug = (line: string) => void;
type RunGit = (args: string[]) => Promise<string>;
export type CommitExists = (repoPath: string, hash: string) => Promise<boolean>;

/** Every `[@arch:KEY]` named in a repo's docs/arch/*.md; undefined when unreadable. */
function archKeysOf(repoPath: string): Set<string> | undefined {
  try {
    const dir = join(repoPath, ARCH_DIR);
    const keys = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\[@arch:([A-Z0-9_-]+)\]/g)) keys.add(m[1]!);
    }
    return keys;
  } catch {
    return undefined;
  }
}

/** The distinct repoPaths of the named manifest repositories. */
export function repoPathsOf(
  manifest: { repositories: Record<string, { repoPath: string }> } | undefined,
  names: readonly string[],
): string[] {
  return [...new Set(names.flatMap((n) => manifest?.repositories[n]?.repoPath ?? []))];
}

/** For each `@arch:KEY` constraint, the docs/arch file (by name) that defines it. */
export function archDocFiles(constraints: readonly string[], repoPaths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of constraints) {
    const key = ARCH_CONSTRAINT.exec(c)?.[1];
    if (!key) continue;
    for (const repo of repoPaths) {
      const dir = join(repo, ARCH_DIR);
      try {
        const file = readdirSync(dir).filter((n) => n.endsWith('.md')).find((n) => readFileSync(join(dir, n), 'utf8').includes(`[@arch:${key}]`));
        if (file) {
          out[c] = file;
          break;
        }
      } catch {
        // unreadable docs: the chip simply shows no file name
      }
    }
  }
  return out;
}

export function archWarnings(constraints: readonly string[], repoPaths: readonly string[], debug: Debug): string[] {
  const malformed = constraints
    .filter((c) => c.startsWith('@arch:') && !ARCH_CONSTRAINT.test(c))
    .map((c) => `malformed design key ${c}`);
  const wanted = constraints.flatMap((c) => ARCH_CONSTRAINT.exec(c)?.[1] ?? []);
  if (wanted.length === 0 || repoPaths.length === 0) return malformed;
  const sets = repoPaths.map(archKeysOf).filter((s): s is Set<string> => s !== undefined);
  if (sets.length === 0) {
    debug(`[planning] constraint check: no readable docs/arch in ${repoPaths.length} repo(s) — @arch keys not verified`);
    return malformed;
  }
  return [...malformed, ...wanted.filter((k) => !sets.some((s) => s.has(k))).map((k) => `unknown design key @arch:${k}`)];
}

export function sensitivePathWarning(p: { description: string; summary: string; constraints?: readonly string[] }): string[] {
  const text = `${p.description}\n${p.summary}`;
  const touches = PROMPT_SENSITIVE_PATHS.some((path) => text.includes(path));
  const cited = (p.constraints ?? []).some((c) => ARCH_CONSTRAINT.test(c));
  return touches && !cited ? ['touches prompt-sensitive code without citing a design rule'] : [];
}

export async function commitWarnings(
  constraints: readonly string[],
  repoPaths: readonly string[],
  exists: CommitExists,
  debug: Debug,
): Promise<string[]> {
  const hashes = constraints.filter((c) => COMMIT_CONSTRAINT.test(c));
  if (hashes.length === 0 || repoPaths.length === 0) return [];
  const warnings: string[] = [];
  for (const hash of hashes) {
    const results = await Promise.all(
      repoPaths.map((r) =>
        exists(r, hash).catch((e: unknown) => {
          debug(`[planning] constraint check: commit ${hash} in ${r} not checked: ${e instanceof Error ? e.message : String(e)}`);
          return undefined;
        }),
      ),
    );
    if (results.every((r) => r === false)) warnings.push(`unknown commit ${hash}`);
  }
  return warnings;
}

/** `git cat-file -e <hash>^{commit}`: exit status → false; a spawn failure rethrows. */
export async function commitExistsViaGit(repoPath: string, hash: string, runGit: RunGit): Promise<boolean> {
  try {
    await runGit(['-C', repoPath, 'cat-file', '-e', `${hash}^{commit}`]);
    return true;
  } catch (e) {
    if (typeof (e as { code?: unknown }).code === 'number') return false;
    throw e;
  }
}
