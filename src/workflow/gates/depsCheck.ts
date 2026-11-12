import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Whether a target's installed dependency tree can serve its lockfile before
 * npm script gates run. A karst worktree has no `node_modules` of its own and
 * resolves up to the main checkout's shared tree; when that tree drifted from
 * the worktree's `package-lock.json`, every gate fails identically for every
 * worktree at once — which reads as a pre-existing code regression instead of
 * an environment problem. `ok: false` is a SETUP failure: the caller parks
 * (`blocked`, no attempt consumed) rather than returning a test verdict.
 */
/**
 * `dir` on a failure is the directory whose tree was actually probed — the main
 * checkout for a resolve-up worktree — so the repair the caller names points at
 * the tree that would be repaired, not at the worktree that has no tree.
 */
export type NodeDepsCheck =
  | { ok: true }
  | { ok: false; kind: 'dependency-drift'; reason: string; dir?: string }
  | { ok: false; kind: 'unreadable'; reason: string; dir?: string };

const MAX_LISTED_PROBLEMS = 3;
/** Above this, an all-`missing:` tree is summarized by count instead of listed. */
const MISSING_SUMMARY_THRESHOLD = 3;

/**
 * Classify `npm ls --json` output. npm exits nonzero for a whole family of
 * tree problems; only the ones that break running tests — `missing:`,
 * `invalid:`, conflicts — count as drift. `extraneous:` packages (installed
 * but not in the lockfile) are benign and must not block.
 */
export function classifyNpmProblems(output: string): NodeDepsCheck {
  try {
    const parsed = JSON.parse(output) as { problems?: unknown };
    const problems = Array.isArray(parsed.problems) ? parsed.problems.map(String) : [];
    const drift = problems.filter((p) => !p.startsWith('extraneous:'));
    if (drift.length === 0) return { ok: true };
    const missing = drift.filter((p) => p.startsWith('missing:'));
    // A whole uninstalled tree is one fact, not N. Listing three of a thousand
    // `missing:` lines reads as a lockfile drift in three packages and sends the
    // reader after the wrong repair; the count names what actually happened.
    const summary =
      missing.length === drift.length && missing.length > MISSING_SUMMARY_THRESHOLD
        ? `${missing.length} dependencies missing (run 'npm ci')`
        : drift.slice(0, MAX_LISTED_PROBLEMS).join('; ');
    return { ok: false, kind: 'dependency-drift', reason: summary };
  } catch {
    return { ok: false, kind: 'unreadable', reason: 'npm ls output was not parseable JSON' };
  }
}

/** Parse a JSON file into an object; `undefined` when absent, a throw when malformed. */
function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function stringKeys(value: unknown): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value) : [];
}

/**
 * The version the lockfile pins for `name`, or `undefined` when it pins none
 * (a link, a workspace, an entry without a version). Reads the v2/v3 `packages`
 * map, then the v1 `dependencies` map.
 */
function lockedVersion(lock: Record<string, unknown>, name: string): string | undefined {
  const entry = (lock.packages as Record<string, { version?: unknown; link?: unknown }> | undefined)?.[
    `node_modules/${name}`
  ] ?? (lock.dependencies as Record<string, { version?: unknown }> | undefined)?.[name];
  if (entry === undefined || (entry as { link?: unknown }).link === true) return undefined;
  return typeof entry.version === 'string' ? entry.version : undefined;
}

/** Node's resolve-up: every `node_modules/<name>/package.json` from `cwd` to the root, then `extra`. */
function resolveInstalledVersion(name: string, cwd: string, extra?: string): string | undefined | null {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) break;
  }
  if (extra !== undefined) dirs.push(extra);
  for (const dir of dirs) {
    const file = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(file)) continue;
    const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  }
  return null;
}

/**
 * Verify, per declared dependency, that what the worktree RESOLVES (its own
 * `node_modules`, then every parent, then the main checkout) is the version its
 * own `package-lock.json` pins. The worktree's partial local `node_modules`
 * (`.vite`, `better-sqlite3`) says nothing about the rest, and `npm ls` in the
 * main checkout compares that tree with its OWN lockfile, so neither sees a
 * dependency the base added. Extraneous installs are never examined. Skipped
 * when the target declares no `package-lock.json`.
 */
export async function checkNodeDeps(
  cwd: string,
  opts: {
    signal?: AbortSignal;
    onDebug?: (message: string) => void;
    /** The main checkout the worktree resolves up to; named as the repair target. */
    repoRoot?: string;
  } = {},
): Promise<NodeDepsCheck> {
  if (!existsSync(join(cwd, 'package-lock.json'))) return { ok: true };
  const repoRoot = opts.repoRoot !== undefined && opts.repoRoot !== cwd ? opts.repoRoot : undefined;
  const dir = repoRoot ?? cwd;
  let names: string[];
  let lock: Record<string, unknown>;
  try {
    const pkg = readJsonObject(join(cwd, 'package.json')) ?? {};
    names = [...new Set([...stringKeys(pkg.dependencies), ...stringKeys(pkg.devDependencies)])];
    lock = readJsonObject(join(cwd, 'package-lock.json')) ?? {};
  } catch (e) {
    return { ok: false, kind: 'unreadable', reason: e instanceof Error ? e.message : String(e), dir };
  }
  opts.onDebug?.(`[gate] deps: checking ${names.length} dependencies of ${cwd} against its lockfile`);
  const problems: string[] = [];
  const missing: string[] = [];
  try {
    for (const name of names) {
      const want = lockedVersion(lock, name);
      const have = resolveInstalledVersion(name, cwd, repoRoot);
      if (have === null) {
        missing.push(`missing: ${name}${want === undefined ? '' : `@${want}`}`);
      } else if (want !== undefined && have !== want) {
        problems.push(`invalid: ${name}@${have ?? 'unknown'} installed, lockfile wants ${want}`);
      }
    }
  } catch (e) {
    return { ok: false, kind: 'unreadable', reason: e instanceof Error ? e.message : String(e), dir };
  }
  if (missing.length + problems.length === 0) return { ok: true };
  const reason =
    problems.length === 0 && missing.length > MISSING_SUMMARY_THRESHOLD
      ? `${missing.length} dependencies missing`
      : [...missing, ...problems].slice(0, MAX_LISTED_PROBLEMS).join('; ');
  return { ok: false, kind: 'dependency-drift', reason, dir };
}

/**
 * The park text for a failed check. Drift names two repairs: bring the main
 * checkout to the base and `npm ci` there, or install in the worktree itself
 * (`reinstallDeps`, which sets deps_mode='local'). Shared by review and UAT.
 */
export function describeDepsBlock(
  check: Extract<NodeDepsCheck, { ok: false }>,
  label: string,
  targetPath: string,
): string {
  if (check.kind !== 'dependency-drift') {
    return `${label}: could not verify installed dependencies — ${check.reason}`;
  }
  return (
    `${label}: installed dependencies do not match package-lock.json — ${check.reason}. ` +
    `Repair (a): update the main checkout to the base, then run 'npm ci' in ${check.dir ?? targetPath}. ` +
    `Repair (b): run the local install ('npm install' in ${targetPath}, reinstallDeps, deps_mode='local').`
  );
}
