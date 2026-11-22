import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../../manifest/types.js';
import { resolveBaselineBranch } from '../../manifest/baselineBranch.js';
import { PROMPT_SENSITIVE_PATHS } from '../../planning/proposal.js';
import { clipToken, extractReferencedPaths, jaccard, MAX_WARNING_CHARS } from '../../planning/draftQualityChecks.js';
import type { OverlapCandidate } from '../../store/draftOverlap.js';

/**
 * Host-side checks of a draft's `constraints` at ingest. They only ever produce
 * WARNINGS (shown on the card and review page); a check that cannot run is
 * skipped with a debug line, never turned into a rejection.
 */

const ARCH_CONSTRAINT = /^@arch:([A-Z0-9_-]+)$/;
const COMMIT_CONSTRAINT = /^[0-9a-f]{7,40}$/;

type Debug = (line: string) => void;
type RunGit = (args: string[]) => Promise<string>;
export type CommitExists = (repoPath: string, hash: string) => Promise<boolean>;

type DesignNamespace = 'arch' | 'ui';
/**
 * The design-key namespaces. Keys are bare tokens (`^…$`). `@ui` allows the
 * dotted (`@ui:1.1`) and lowercase-suffix (`@ui:UI-R09b`) keys that docs/ui
 * uses; `@arch` keeps its upper-case class.
 */
const DESIGN_NAMESPACES: Record<DesignNamespace, { key: RegExp; ref: RegExp; dir: string }> = {
  arch: { key: /^[A-Z0-9_-]+$/, ref: /\[@arch:([A-Z0-9_-]+)\]/g, dir: join('docs', 'arch') },
  ui: { key: /^[A-Za-z0-9._-]+$/, ref: /\[@ui:([A-Za-z0-9._-]+)\]/g, dir: join('docs', 'ui') },
};
const DESIGN_ORDER: readonly DesignNamespace[] = ['ui', 'arch'];
const DESIGN_PREFIX = /^@(arch|ui):/;
const MALFORMED_PREFIX = 'malformed design key ';
const UNKNOWN_PREFIX = 'unknown design key ';

type DesignKey = { ns: DesignNamespace; key: string } | 'malformed' | undefined;

/** A `@arch:KEY` / `@ui:KEY` constraint, `'malformed'` for a bad key, undefined for any other entry. */
function parseDesignKey(c: string): DesignKey {
  const m = DESIGN_PREFIX.exec(c);
  if (!m) return undefined;
  const ns = m[1] as DesignNamespace;
  const key = c.slice(m[0].length);
  return DESIGN_NAMESPACES[ns].key.test(key) ? { ns, key } : 'malformed';
}

/** Every `[@<ns>:KEY]` named in a repo's docs/<ns>/*.md; undefined when unreadable. */
function designKeysOf(repoPath: string, ns: DesignNamespace): Set<string> | undefined {
  const { dir, ref } = DESIGN_NAMESPACES[ns];
  try {
    const abs = join(repoPath, dir);
    const keys = new Set<string>();
    for (const f of readdirSync(abs).filter((n) => n.endsWith('.md'))) {
      for (const m of readFileSync(join(abs, f), 'utf8').matchAll(ref)) keys.add(m[1]!);
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

/**
 * Record, per manifest repository NAME, the sha of the ticket's planned base
 * (BASE-PER: `origin/<baseline branch>`, then the local branch) via host-side
 * git. Names sharing a repoPath each get their own entry. Unresolvable bases
 * are omitted; this never blocks ingest. ASYNC on purpose: it runs in the
 * extension host, whose event loop must never block on a child process.
 */
export async function resolveBaseShasOf(
  manifest: Manifest | undefined,
  names: readonly string[],
  runGit: (repoPath: string, args: string[]) => Promise<string> = defaultAsyncGit,
): Promise<Record<string, string>> {
  const shas: Record<string, string> = {};
  if (!manifest) return shas;
  for (const name of names) {
    const repository = manifest.repositories[name];
    if (!repository?.repoPath) continue;
    const branch = resolveBaselineBranch(manifest, repository);
    for (const ref of [`origin/${branch}`, branch]) {
      try {
        const sha = (await runGit(repository.repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
        if (sha.length >= 7) {
          shas[name] = sha;
          break;
        }
      } catch {
        // ref missing or git failure: try the next, else omit
      }
    }
  }
  return shas;
}

/** `git <args>` in `repoPath`, rejecting on failure. Async so it never blocks the host loop. */
function defaultAsyncGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: repoPath, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** For each `@arch:KEY` / `@ui:KEY` constraint, the docs/<ns> file (by name) that defines it. */
export function archDocFiles(constraints: readonly string[], repoPaths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of constraints) {
    const parsed = parseDesignKey(c);
    if (parsed === undefined || parsed === 'malformed') continue;
    const { dir } = DESIGN_NAMESPACES[parsed.ns];
    for (const repo of repoPaths) {
      const abs = join(repo, dir);
      try {
        const file = readdirSync(abs)
          .filter((n) => n.endsWith('.md'))
          .find((n) => readFileSync(join(abs, n), 'utf8').includes(`[@${parsed.ns}:${parsed.key}]`));
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

/** The well-formed keys of one namespace, as their full constraint text. */
function keysIn(constraints: readonly string[], ns: DesignNamespace): string[] {
  return constraints.filter((c) => {
    const p = parseDesignKey(c);
    return p !== undefined && p !== 'malformed' && p.ns === ns;
  });
}

export function archWarnings(constraints: readonly string[], repoPaths: readonly string[], debug: Debug): string[] {
  const malformed = constraints
    .filter((c) => parseDesignKey(c) === 'malformed')
    .map((c) => `${MALFORMED_PREFIX}${clipToken(c, MAX_WARNING_CHARS - MALFORMED_PREFIX.length)}`);
  const unknown: string[] = [];
  for (const ns of DESIGN_ORDER) {
    const wanted = keysIn(constraints, ns);
    if (wanted.length === 0 || repoPaths.length === 0) continue;
    const sets = repoPaths.map((r) => designKeysOf(r, ns)).filter((s): s is Set<string> => s !== undefined);
    if (sets.length === 0) {
      debug(`[planning] constraint check: no readable docs/${ns} in ${repoPaths.length} repo(s) — @${ns} keys not verified`);
      continue;
    }
    for (const c of wanted) {
      const key = c.slice(`@${ns}:`.length);
      if (!sets.some((s) => s.has(key))) unknown.push(`${UNKNOWN_PREFIX}${clipToken(c, MAX_WARNING_CHARS - UNKNOWN_PREFIX.length)}`);
    }
  }
  return [...malformed, ...unknown];
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

/** A distinct repository checkout and the base branch its draft is planned against. */
export interface PathRepoTarget {
  repoPath: string;
  baseBranch: string;
}
/** One async `git cat-file --batch-check` in `repoPath`, `input` on stdin; resolves to stdout. */
export type GitBatch = (repoPath: string, input: string) => Promise<string>;

export const MAX_CHECKED_PATHS = 50;
export const MAX_MISSING_PATH_WARNINGS = 3;
const GIT_BATCH_TIMEOUT_MS = 5000;
const GIT_BATCH_MAX_BUFFER = 1024 * 1024;
const OBJECT_LINE = /^[0-9a-f]{40,64} \S+ \d+$/;
const MISSING_PREFIX = 'missing path at base: ';

/** The distinct repoPaths of the named repositories, each with its base branch (BASE-PER). */
export function repoTargetsOf(manifest: Manifest | undefined, names: readonly string[]): PathRepoTarget[] {
  if (!manifest) return [];
  const byPath = new Map<string, PathRepoTarget>();
  for (const name of names) {
    const repository = manifest.repositories[name];
    if (!repository?.repoPath || byPath.has(repository.repoPath)) continue;
    byPath.set(repository.repoPath, { repoPath: repository.repoPath, baseBranch: resolveBaselineBranch(manifest, repository) });
  }
  return [...byPath.values()];
}

/** The spellings that count as `path` at base: an ESM `.js` specifier also matches its `.ts`/`.tsx` source. */
export function pathVariants(path: string): string[] {
  if (!path.endsWith('.js')) return [path];
  const stem = path.slice(0, -'.js'.length);
  return [path, `${stem}.ts`, `${stem}.tsx`];
}

/**
 * The paths missing at the planned base of `target`, from ONE `cat-file
 * --batch-check`: the input holds `<ref>^{commit}` for `origin/<base>`,
 * `<base>` and `HEAD`, then `<ref>:<path>` for every ref and path variant.
 * The first ref that resolves wins. Undefined when none resolves.
 */
export async function missingPathsViaGitBatch(
  target: PathRepoTarget,
  paths: readonly string[],
  batch: GitBatch,
): Promise<string[] | undefined> {
  const refs = [`origin/${target.baseBranch}`, target.baseBranch, 'HEAD'];
  const variants = paths.map(pathVariants);
  const perRef = variants.reduce((n, v) => n + v.length, 0);
  const lines = [
    ...refs.map((r) => `${r}^{commit}`),
    ...refs.flatMap((r) => variants.flatMap((vs) => vs.map((v) => `${r}:${v}`))),
  ];
  const out = (await batch(target.repoPath, `${lines.join('\n')}\n`)).split('\n');
  const found = (i: number): boolean => OBJECT_LINE.test(out[i] ?? '');
  const refIndex = refs.findIndex((_, i) => found(i));
  if (refIndex === -1) return undefined;
  let cursor = refs.length + refIndex * perRef;
  const missing: string[] = [];
  variants.forEach((vs, i) => {
    if (!vs.some((_, j) => found(cursor + j))) missing.push(paths[i]!);
    cursor += vs.length;
  });
  return missing;
}

/**
 * `missing path at base: <path>` for each path that no checked target has at
 * its planned base (at most 3, then `+N more missing paths at base`). One batch
 * per target, all in parallel. A target whose git fails or whose base does not
 * resolve is skipped with a `[planning]` debug line; with no checked target,
 * nothing is reported.
 */
export async function missingPathWarnings(
  paths: readonly string[],
  targets: readonly PathRepoTarget[],
  batch: GitBatch,
  debug: Debug,
): Promise<string[]> {
  const wanted = [...new Set(paths.filter((p) => !/[\r\n]/.test(p)))].slice(0, MAX_CHECKED_PATHS);
  if (wanted.length === 0 || targets.length === 0) return [];
  const results = await Promise.all(
    targets.map((t) =>
      missingPathsViaGitBatch(t, wanted, batch).then(
        (missing) => {
          if (missing === undefined) debug(`[planning] path check in ${t.repoPath}: no base ref — paths not verified`);
          return missing;
        },
        (e: unknown) => {
          debug(`[planning] path check in ${t.repoPath} skipped: ${e instanceof Error ? e.message : String(e)}`);
          return undefined;
        },
      ),
    ),
  );
  const checked = results.filter((r): r is string[] => r !== undefined);
  if (checked.length === 0) return [];
  const missing = wanted.filter((p) => checked.every((m) => m.includes(p)));
  const shown = missing
    .slice(0, MAX_MISSING_PATH_WARNINGS)
    .map((p) => `${MISSING_PREFIX}${clipToken(p, MAX_WARNING_CHARS - MISSING_PREFIX.length)}`);
  const rest = missing.length - shown.length;
  return rest > 0 ? [...shown, `+${rest} more missing paths at base`] : shown;
}

/**
 * The default GitBatch: async `git -C <repoPath> cat-file --batch-check` with
 * `input` on stdin. ASYNC on purpose: it runs in the extension host, whose event
 * loop must never block on a child process. `execFile` kills it on timeout and
 * caps its output.
 */
export function gitCatFileBatch(repoPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', repoPath, 'cat-file', '--batch-check'],
      { encoding: 'utf8', timeout: GIT_BATCH_TIMEOUT_MS, maxBuffer: GIT_BATCH_MAX_BUFFER },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    // A stdin failure (EPIPE when git exits early) rejects; a later reject is a no-op.
    child.stdin?.on('error', reject);
    child.stdin?.end(input);
  });
}

export const OVERLAP_MIN_SHARED_FILES = 2;
export const TITLE_SIMILARITY = 0.65;
export const MIN_TITLE_TOKENS = 3;
export const MAX_OVERLAP_WARNINGS = 3;
const MIN_TOKEN_LENGTH = 3;
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'when', 'not', 'are', 'via', 'per',
  'add', 'fix', 'feat', 'chore', 'docs', 'refactor', 'test', 'tests', 'perf',
]);

/** Source files a draft names (edited or created); docs and Markdown never count as overlap. */
function sourceFilesOf(text: string): Set<string> {
  const { existing, created } = extractReferencedPaths(text);
  return new Set([...existing, ...created].filter((p) => !p.startsWith('docs/') && !p.endsWith('.md')));
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= MIN_TOKEN_LENGTH && !TITLE_STOPWORDS.has(w)),
  );
}

/**
 * Open drafts and tickets that look like the same work as `incoming`: 2+
 * shared source files, else a close title. `candidates` already excludes the
 * draft itself and everything linked to it (`listOverlapCandidates`).
 */
export function overlapWarnings(
  incoming: { title: string; description: string },
  candidates: readonly OverlapCandidate[],
): string[] {
  const files = sourceFilesOf(incoming.description);
  const tokens = titleTokens(incoming.title);
  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= MAX_OVERLAP_WARNINGS) break;
    const shared = [...sourceFilesOf(c.description)].filter((f) => files.has(f)).length;
    if (shared >= OVERLAP_MIN_SHARED_FILES) {
      out.push(`overlaps files with ${c.ref} (add dependsOn?)`);
      continue;
    }
    const other = titleTokens(c.title);
    if (tokens.size >= MIN_TITLE_TOKENS && other.size >= MIN_TITLE_TOKENS && jaccard(tokens, other) >= TITLE_SIMILARITY) {
      out.push(`title closely matches ${c.ref}`);
    }
  }
  return out;
}
