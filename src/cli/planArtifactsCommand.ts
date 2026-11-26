import * as nodeFs from 'node:fs';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { KARST_PROJECT_ENV } from '../agent/cliEnv.js';
import { formatId } from '../model/entityId.js';
import { KARST_PLANNING_SESSION_ENV, PLANNING_ARTIFACTS_ENV } from '../planning/preamble.js';

/**
 * `karst plan-artifacts list|import` — how a PLANNING session reads a file of
 * ANOTHER planning session of the same project, with one deterministic call
 * instead of a guessed storage path and a manual `cp`.
 *
 * Both subcommands open the store READ-ONLY (`KARST_DB_READONLY`, `@arch:CLI-05`)
 * only to prove that the named session belongs to `KARST_PROJECT`; the files
 * themselves come from `<scratchRoot>/<id>/`. `list` walks that dir without
 * following any link. `import` confines one regular file (realpath inside the
 * session dir, no link at any segment, hardlink refused, `O_NOFOLLOW`, dev/ino
 * matched after open, 10 MB cap) and writes it atomically into the caller's own
 * `$KARST_ARTIFACTS`.
 *
 * The confinement guards against MISTAKES, not against a hostile planner: a
 * shell-capable agent can copy any file itself. It never widens the host's own
 * confinement root (@arch:CLI-25).
 *
 * Reads and writes are synchronous on purpose: this is the one-shot CLI
 * process, never the extension host (the same posture as `draftCommand.ts`).
 */

/** The largest file `import` copies. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** The most rows `list` prints (sorted first, then cut). */
export const MAX_LIST_ENTRIES = 500;

/** The fs calls this module makes, injectable so tests can point at a tmp tree. */
export type PlanArtifactsFs = Pick<
  typeof nodeFs,
  | 'realpathSync'
  | 'lstatSync'
  | 'statSync'
  | 'readdirSync'
  | 'openSync'
  | 'fstatSync'
  | 'readSync'
  | 'closeSync'
  | 'writeFileSync'
  | 'renameSync'
  | 'unlinkSync'
>;

export interface PlanArtifactsDeps {
  /** The planning session's process env. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The project id that owns planning session `id`, or undefined when it does not exist. */
  readonly sessionProject: (sessionId: number) => number | undefined;
  /** Injectable fs (defaults to `node:fs`); tests use real tmp dirs. */
  readonly fs?: PlanArtifactsFs;
}

/** One row of `list`; `path` is relative to the session scratch dir, `/`-separated. */
export interface PlanArtifactRow {
  readonly path: string;
  readonly bytes: number;
  /** ISO-8601 modification time. */
  readonly mtime: string;
}

interface Parsed {
  readonly action: 'list' | 'import';
  readonly session?: number;
  readonly path?: string;
  readonly as?: string;
  readonly force: boolean;
  readonly json: boolean;
}

const SESSION_RE = /^[Pp]?([1-9][0-9]*)$/;

function fail(message: string): never {
  throw new Error(`karst plan-artifacts: ${message}`);
}

/** Parse a `P<n>` session reference (a bare integer is accepted too). */
function sessionNumber(raw: string, where: string): number {
  const m = SESSION_RE.exec(raw.trim());
  if (!m) fail(`${where} must be P<n>, got '${raw}'`);
  return Number(m[1]!);
}

function flagValue(rest: readonly string[], at: number, flag: string): string {
  const value = rest[at + 1];
  if (value === undefined) fail(`${flag} needs a value`);
  return value;
}

export function parsePlanArtifactsArgs(argv: readonly string[]): Parsed {
  const [verb, action, ...rest] = argv;
  if (verb !== 'plan-artifacts') fail(`unknown command '${verb ?? ''}'`);
  if (action !== 'list' && action !== 'import') {
    fail(`unknown subcommand '${action ?? ''}' (want 'list' or 'import')`);
  }
  let session: number | undefined;
  let path: string | undefined;
  let as: string | undefined;
  let force = false;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--session') session = sessionNumber(flagValue(rest, i, flag), '--session');
    else if (flag === '--path') path = flagValue(rest, i, flag);
    else if (flag === '--as') as = flagValue(rest, i, flag);
    else if (flag === '--force') force = true;
    else if (flag === '--json') json = true;
    else fail(`unknown flag '${flag}' (want --session, --path, --as, --force or --json)`);
    if (flag !== '--force' && flag !== '--json') i++;
  }
  if (action === 'list') {
    if (path !== undefined || as !== undefined || force) fail('--path, --as and --force are for import only');
  } else {
    if (path === undefined) fail('import needs --path <rel>');
  }
  return { action, ...(session === undefined ? {} : { session }), ...(path === undefined ? {} : { path }), ...(as === undefined ? {} : { as }), force, json };
}

/** The session id whose scratch dir this process runs in, from `KARST_PLANNING_SESSION`. */
function ownSession(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[KARST_PLANNING_SESSION_ENV];
  if (raw === undefined || raw === '') {
    fail(`${KARST_PLANNING_SESSION_ENV} is not set (run it inside a planning session)`);
  }
  return sessionNumber(raw, KARST_PLANNING_SESSION_ENV);
}

/** The project this session was launched for, from `KARST_PROJECT`. */
function ownProject(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[KARST_PROJECT_ENV];
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    fail(`${KARST_PROJECT_ENV} is not set (run it inside a planning session)`);
  }
  return Number(raw);
}

interface Roots {
  /** The caller's own artifacts dir (real path). */
  readonly artifacts: string;
  /** The parent of every session dir (real path). */
  readonly scratchRoot: string;
}

/**
 * The two roots this verb may touch: the caller's artifacts dir and the scratch
 * root beside it. Refused unless `$KARST_ARTIFACTS` really is
 * `<scratchRoot>/<ownSession>/artifacts`, so a forged env cannot point the copy
 * at another session's dir or a repository.
 */
function roots(env: Readonly<Record<string, string | undefined>>, fs: PlanArtifactsFs): Roots {
  const own = ownSession(env);
  const raw = env[PLANNING_ARTIFACTS_ENV];
  if (raw === undefined || raw === '') {
    fail(`${PLANNING_ARTIFACTS_ENV} is not set (run it inside a planning session)`);
  }
  let artifacts: string;
  try {
    artifacts = fs.realpathSync(raw);
    if (!fs.statSync(artifacts).isDirectory()) throw new Error('not a directory');
  } catch {
    fail(`${PLANNING_ARTIFACTS_ENV} (${raw}) is not a directory`);
  }
  if (basename(artifacts) !== 'artifacts') {
    fail(`${PLANNING_ARTIFACTS_ENV} (${raw}) must be the session's "artifacts" dir`);
  }
  const sessionDir = dirname(artifacts);
  if (basename(sessionDir) !== String(own)) {
    fail(`${PLANNING_ARTIFACTS_ENV} (${raw}) belongs to another planning session, not ${formatId('plan', own)}`);
  }
  return { artifacts, scratchRoot: dirname(sessionDir) };
}

/**
 * The target session's dir, resolved and checked to be a direct child of the
 * scratch root. A pruned or absent session dir is an error, not an empty list.
 */
function targetSessionDir(roots: Roots, sessionId: number, fs: PlanArtifactsFs): string {
  const wanted = join(roots.scratchRoot, String(sessionId));
  let real: string;
  try {
    real = fs.realpathSync(wanted);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    fail(`the scratch dir of planning session ${formatId('plan', sessionId)} does not exist`);
  }
  if (dirname(real) !== roots.scratchRoot || basename(real) !== String(sessionId)) {
    fail(`the scratch dir of planning session ${formatId('plan', sessionId)} is outside the sessions root`);
  }
  return real;
}

/** True for a name `list` skips and `import` refuses: dot entries and the session's own bookkeeping. */
function isSkippedSegment(name: string): boolean {
  return name.startsWith('.') || name.startsWith('outbox') || name === 'proposals.json' || name === 'karst-instructions.md';
}

/** Prove the target session exists and belongs to the caller's project. */
function assertSameProject(deps: PlanArtifactsDeps, sessionId: number, projectId: number): void {
  const owner = deps.sessionProject(sessionId);
  if (owner === undefined) fail(`planning session ${formatId('plan', sessionId)} not found`);
  if (owner !== projectId) {
    fail(`planning session ${formatId('plan', sessionId)} belongs to another project`);
  }
}

function listFiles(root: string, fs: PlanArtifactsFs): PlanArtifactRow[] {
  const rows: PlanArtifactRow[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: nodeFs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isSkippedSegment(entry.name)) continue;
      const full = join(dir, entry.name);
      let stat: nodeFs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      // Never follow a link — not into a repo, not into another session.
      if (stat.isSymbolicLink()) continue;
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (stat.isDirectory()) walk(full, path);
      else if (stat.isFile()) rows.push({ path, bytes: stat.size, mtime: stat.mtime.toISOString() });
    }
  };
  walk(root, '');
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows.slice(0, MAX_LIST_ENTRIES);
}

function formatTable(rows: readonly PlanArtifactRow[]): string {
  if (rows.length === 0) return 'no files';
  const headers = ['PATH', 'BYTES', 'MTIME'];
  const body = rows.map((r) => [r.path, String(r.bytes), r.mtime]);
  const widths = headers.map((_, c) => Math.max(...[headers, ...body].map((r) => r[c]!.length)));
  return [headers, ...body]
    .map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join('  ').trimEnd())
    .join('\n');
}

/** Split a relative path into segments, refusing absolute paths and `\` separators on every OS. */
function relativeSegments(rel: string): string[] {
  if (rel === '' || isAbsolute(rel) || rel.includes('\\')) {
    fail('--path must be relative to the session scratch dir');
  }
  return rel.split('/');
}

interface Confined {
  readonly path: string;
  readonly stat: nodeFs.Stats;
}

/**
 * Resolve one `--path` inside a session dir. Every segment is `lstat`ed and may
 * not be a link; the last one must be a unique regular file inside the dir.
 * This refuses `..`, an absolute path, a reserved name, a symlinked parent, a
 * folder, a hardlink and an oversize file BEFORE anything is opened.
 */
function confine(sessionDir: string, rel: string, fs: PlanArtifactsFs): Confined {
  const segments = relativeSegments(rel);
  if (segments.some((s) => s === '' || s === '..')) fail(`--path '${rel}' is outside the session scratch dir`);
  if (segments.some(isSkippedSegment)) fail(`--path '${rel}' is a skipped entry`);
  let current = sessionDir;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!);
    let stat: nodeFs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      fail(`'${rel}' does not exist in the session`);
    }
    if (stat.isSymbolicLink()) fail(`'${rel}' is a link`);
    if (i < segments.length - 1) {
      if (!stat.isDirectory()) fail(`'${rel}' is not a regular file`);
    } else {
      if (!stat.isFile()) fail(`'${rel}' is not a regular file (a folder or a device)`);
      if (stat.nlink !== 1) fail(`'${rel}' is a hardlink (nlink ${stat.nlink})`);
      if (stat.size > MAX_IMPORT_BYTES) fail(`'${rel}' is too large (max ${MAX_IMPORT_BYTES} bytes)`);
    }
  }
  // Parent links were refused above; re-check the full real path anyway, because
  // a path can leave the dir through a mount or a link this walk did not see.
  const real = fs.realpathSync(current);
  const relReal = relative(sessionDir, real);
  if (relReal === '' || relReal === '..' || relReal.startsWith(`..${sep}`) || isAbsolute(relReal)) {
    fail(`'${rel}' is outside the session scratch dir`);
  }
  return { path: current, stat: fs.lstatSync(current) };
}

/** Read at most `MAX_IMPORT_BYTES + 1` bytes from an open fd. */
function readBounded(fd: number, fs: PlanArtifactsFs): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  while (total <= MAX_IMPORT_BYTES) {
    const n = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
    total += n;
  }
  if (total > MAX_IMPORT_BYTES) fail(`the file is too large (max ${MAX_IMPORT_BYTES} bytes)`);
  return Buffer.concat(chunks);
}

/** The destination name: `--as` when given, else the source basename. One plain segment. */
function destinationName(as: string | undefined, file: string): string {
  const name = as ?? basename(file);
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    basename(name) !== name
  ) {
    fail("--as must be one file name (no '/', no '\\', no '..', not empty)");
  }
  return name;
}

function runImport(parsed: Parsed, deps: PlanArtifactsDeps, fs: PlanArtifactsFs): string {
  if (parsed.session === undefined) fail('import needs --session P<n>');
  const dirs = roots(deps.env, fs);
  const projectId = ownProject(deps.env);
  assertSameProject(deps, parsed.session, projectId);
  const sessionDir = targetSessionDir(dirs, parsed.session, fs);
  const source = confine(sessionDir, parsed.path!, fs);
  const name = destinationName(parsed.as, source.path);

  const destination = join(dirs.artifacts, name);
  let existing: nodeFs.Stats | undefined;
  try {
    existing = fs.lstatSync(destination);
  } catch {
    // A missing destination is the normal case.
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) fail(`destination '${name}' is a link`);
    if (existing.isDirectory()) fail(`destination '${name}' is a folder`);
    if (!parsed.force) fail(`destination '${name}' already exists (pass --force to overwrite)`);
  }

  // Open the source ONLY after the confinement checks, then prove the fd is the
  // inode that was checked (a swap between the lstat and the open is refused).
  const fd = fs.openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) fail(`'${parsed.path}' is not a regular file`);
    if (opened.dev !== source.stat.dev || opened.ino !== source.stat.ino) {
      fail(`'${parsed.path}' changed while it was read`);
    }
    if (opened.nlink !== 1) fail(`'${parsed.path}' is a hardlink (nlink ${opened.nlink})`);
    if (opened.size > MAX_IMPORT_BYTES) fail(`'${parsed.path}' is too large (max ${MAX_IMPORT_BYTES} bytes)`);
    data = readBounded(fd, fs);
  } finally {
    fs.closeSync(fd);
  }

  // tmp with `wx`, then rename: the destination is never a partial file.
  const tmp = join(dirs.artifacts, `.plan-artifacts-${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(tmp, destination);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort; the rename error is the one that matters.
    }
    throw e;
  }
  return JSON.stringify({ ok: true, path: name });
}

function runList(parsed: Parsed, deps: PlanArtifactsDeps, fs: PlanArtifactsFs): string {
  const dirs = roots(deps.env, fs);
  const projectId = ownProject(deps.env);
  const sessionId = parsed.session ?? ownSession(deps.env);
  assertSameProject(deps, sessionId, projectId);
  const rows = listFiles(targetSessionDir(dirs, sessionId, fs), fs);
  return parsed.json ? JSON.stringify(rows, null, 2) : formatTable(rows);
}

export function runPlanArtifactsCommand(argv: readonly string[], deps: PlanArtifactsDeps): string {
  const parsed = parsePlanArtifactsArgs(argv);
  const fs = deps.fs ?? nodeFs;
  return parsed.action === 'list' ? runList(parsed, deps, fs) : runImport(parsed, deps, fs);
}
