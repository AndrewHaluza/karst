/**
 * The onboarding-setup proposal contract: what the setup session's typed
 * `setup run` and `setup write-file` tools write into the session outbox and
 * what the host ingests. Pure; the CLI and the host import it, so both sides
 * apply the SAME shape, caps and control stripping.
 *
 * Two kinds, discriminated by `kind`:
 *  - `run` - a command that needs consent (git init, install deps, create a
 *    baseline). It carries a purpose and the exact command. The host shows
 *    both and runs the command only on explicit approval. It is not dry-run.
 *  - `write-file` - a file the host writes. The agent gives a relative path
 *    and the content. The HOST builds the patch from them, runs
 *    `git apply --check`, shows the diff and applies it on consent.
 *
 * The old free-form kinds (`manifest` YAML, `change`) are refused here: a
 * hand-written file of those kinds is recorded `invalid: use the typed setup
 * tools`. The agent changes karst.yml only through the typed edit tools.
 * `ChangeProposal` stays as the host's INTERNAL form (the host builds it from
 * a `run` or a `write-file`); it never arrives from the outbox.
 *
 * Matching the planning contract: output is JSON, the host is the sole writer
 * of durable state, and the on-disk outbox is a delivery channel, not a trust
 * boundary. Every value is bounded and control characters are stripped before
 * anything is stored or shown.
 */

/** `KARST_SETUP_OUTBOX` names the setup session's outbox, where these land. */
export const SETUP_OUTBOX_ENV = 'KARST_SETUP_OUTBOX';

export const MAX_SETUP_PROPOSAL_BYTES = 512 * 1024;
export const MAX_SETUP_REASON = 2 * 1024;
export const MAX_SETUP_COMMAND = 4 * 1024;
export const MAX_SETUP_PATCH = 256 * 1024;
export const MAX_SETUP_PATH = 1024;
/** The text of a file the host writes; a patch of it stays under `MAX_SETUP_PATCH`. */
export const MAX_SETUP_WRITE_CONTENT = 128 * 1024;
/** `clears`: at most this many readiness item ids, each matching `SETUP_ITEM_ID`. */
export const MAX_SETUP_CLEARS = 64;
export const SETUP_ITEM_ID = /^[A-Za-z0-9._:#-]{1,200}$/;
/** Repository names use the same grammar as a manifest repository key. */
export const SETUP_REPO_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Why the host refuses a hand-written `manifest` or `change` file in the outbox. */
export const OLD_PROPOSAL_REFUSAL = 'use the typed setup tools';

export const RUN_PURPOSES = ['git-init', 'install-deps', 'create-baseline', 'other'] as const;
export type RunPurpose = (typeof RUN_PURPOSES)[number];

export interface RunProposal {
  kind: 'run';
  /** Manifest repository name (or a directory name for a not-yet-registered repo). */
  repo?: string;
  /** Directory the command runs in: absolute, or relative to the workspace root; must stay inside it. */
  path?: string;
  purpose: RunPurpose;
  /** The exact command to run. */
  command: string;
}

export interface WriteFileProposal {
  kind: 'write-file';
  repo: string;
  /** Relative to the repo directory; never under `.karst/` or `.git/`. The host checks the realpath. */
  path: string;
  /** The whole new content of the file. */
  content: string;
}

/**
 * The host's internal form of a consented repo change. The host builds it from
 * a `run` or a `write-file`; an outbox file of this kind is refused.
 */
export interface ChangeProposal {
  kind: 'change';
  /** Manifest repository name (or a directory name for a not-yet-registered repo). */
  repo: string;
  /** Why the change is needed, in the user's terms. */
  reason: string;
  /** The exact command to run, when the change is a command. */
  command?: string;
  /** A unified-diff patch, when the change is a file edit. */
  patch?: string;
  /** Directory the change runs in: absolute, or relative to the workspace root; must stay inside it. Overrides `repo` for resolution. */
  path?: string;
  /** Readiness item ids the agent says this clears (a claim; the host computes the real list). */
  clears?: string[];
}

export type SetupProposal = RunProposal | WriteFileProposal;
export type SetupProposalResult =
  | { ok: true; value: SetupProposal }
  | { ok: false; reason: string };

// C0 (minus \t \n), DEL, C1, and bidi embedding/override/isolate/mark controls.
const BODY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const ALL_CONTROLS = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function cleanBody(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.length > max) return undefined;
  return v.replace(BODY_CONTROLS, '');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(rec: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  // Every required key present, and no key outside required + optional.
  if (required.some((k) => !(k in rec))) return false;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(rec).every((k) => allowed.has(k));
}

const RESERVED_REPO = /^\.(git|karst)$/i;
const validRepo = (v: unknown): v is string =>
  typeof v === 'string' && SETUP_REPO_NAME.test(v) && v !== '.' && v !== '..' && !RESERVED_REPO.test(v);
const REPO_REASON = 'repo must be a name matching [A-Za-z0-9._-]{1,64}, not ., .., .git or .karst';

/** The outbox contract: a typed `run` or `write-file`. The old kinds are refused. */
export function validateSetupProposal(raw: unknown): SetupProposalResult {
  if (!isRecord(raw)) return fail('proposal must be a JSON object');
  const kind = raw.kind;
  if (kind === 'run') return validateRun(raw);
  if (kind === 'write-file') return validateWriteFile(raw);
  if (kind === 'manifest' || kind === 'change') return fail(OLD_PROPOSAL_REFUSAL);
  return fail("kind must be 'run' or 'write-file'");
}

function validateRun(rec: Record<string, unknown>): SetupProposalResult {
  if (!exactKeys(rec, ['kind', 'purpose', 'command'], ['repo', 'path'])) {
    return fail('run keys must be exactly kind, purpose, command, and a repo or a path (or both)');
  }
  if (rec.repo === undefined && rec.path === undefined) return fail('a run needs a repo or a path');
  if (rec.repo !== undefined && !validRepo(rec.repo)) return fail(REPO_REASON);
  const path = rec.path;
  if (
    path !== undefined &&
    (typeof path !== 'string' || path.trim() === '' || path.length > MAX_SETUP_PATH || path.replace(ALL_CONTROLS, '') !== path)
  ) {
    return fail(`path must be a non-empty string of at most ${MAX_SETUP_PATH} characters without control characters`);
  }
  const purpose = rec.purpose;
  if (typeof purpose !== 'string' || !(RUN_PURPOSES as readonly string[]).includes(purpose)) {
    return fail(`purpose must be one of ${RUN_PURPOSES.join(', ')}`);
  }
  const command = cleanBody(rec.command, MAX_SETUP_COMMAND);
  if (command === undefined || command.trim() === '') {
    return fail(`command must be a non-empty string of at most ${MAX_SETUP_COMMAND} characters`);
  }
  const value: RunProposal = { kind: 'run', purpose: purpose as RunPurpose, command };
  if (rec.repo !== undefined) value.repo = rec.repo as string;
  if (path !== undefined) value.path = path as string;
  return { ok: true, value: orderRun(value) };
}

/** A stable key order, so the stored file reads the same on each run. */
function orderRun(v: RunProposal): RunProposal {
  return { kind: 'run', ...(v.repo !== undefined ? { repo: v.repo } : {}), ...(v.path !== undefined ? { path: v.path } : {}), purpose: v.purpose, command: v.command };
}

const WRITE_PATH_CHARS = /^[A-Za-z0-9._@+/-]+$/;

/** The shape rule for a write-file path. The host checks the realpath of the file on disk. */
export function writeFilePathProblem(path: unknown): string | undefined {
  if (typeof path !== 'string' || path === '' || path.length > MAX_SETUP_PATH) {
    return `path must be a non-empty string of at most ${MAX_SETUP_PATH} characters`;
  }
  if (path.replace(ALL_CONTROLS, '') !== path) return 'path must not contain control characters';
  if (!WRITE_PATH_CHARS.test(path)) return 'path may hold only letters, digits and . _ @ + - / (use / as the separator)';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'path must be relative to the repo';
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'path must not hold an empty, . or .. segment';
  if (segments.some((s) => s.toLowerCase() === '.karst')) return 'path must not be under .karst/; karst.yml changes only through the typed setup tools';
  if (segments.some((s) => s.toLowerCase() === '.git')) return 'path must not be under .git/';
  return undefined;
}

function validateWriteFile(rec: Record<string, unknown>): SetupProposalResult {
  if (!exactKeys(rec, ['kind', 'repo', 'path', 'content'], [])) {
    return fail('write-file keys must be exactly kind, repo, path, content');
  }
  if (!validRepo(rec.repo)) return fail(REPO_REASON);
  const problem = writeFilePathProblem(rec.path);
  if (problem !== undefined) return fail(problem);
  const content = rec.content;
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_SETUP_WRITE_CONTENT || content.includes('\u0000')) {
    return fail(`content must be text (no NUL) of at most ${MAX_SETUP_WRITE_CONTENT} bytes`);
  }
  return { ok: true, value: { kind: 'write-file', repo: rec.repo, path: rec.path as string, content } };
}

/** `undefined` = absent; `null` = present but invalid. */
function cleanClears(v: unknown): string[] | undefined | null {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_SETUP_CLEARS) return null;
  return v.every((id) => typeof id === 'string' && SETUP_ITEM_ID.test(id)) ? [...(v as string[])] : null;
}

const CLEARS_REASON = `clears must be a list of at most ${MAX_SETUP_CLEARS} readiness item ids`;

/** Validates the host's INTERNAL change form: the host builds it, the outbox never carries it. */
export function validateChangeProposal(raw: unknown): { ok: true; value: ChangeProposal } | { ok: false; reason: string } {
  if (!isRecord(raw) || raw.kind !== 'change') return fail("kind must be 'change'");
  const rec = raw;
  if (!exactKeys(rec, ['kind', 'repo', 'reason'], ['kind', 'repo', 'reason', 'command', 'patch', 'path', 'clears'])) {
    return fail('change proposal keys must be exactly kind, repo, reason (plus an optional command or patch, an optional path, and an optional clears)');
  }
  const clears = cleanClears(rec.clears);
  if (clears === null) return fail(CLEARS_REASON);
  const repo = rec.repo;
  if (!validRepo(repo)) return fail(REPO_REASON);
  const reason = cleanBody(rec.reason, MAX_SETUP_REASON);
  if (reason === undefined || reason.trim() === '') {
    return fail(`reason must be a non-empty string of at most ${MAX_SETUP_REASON} characters`);
  }
  const command = rec.command === undefined ? undefined : cleanBody(rec.command, MAX_SETUP_COMMAND);
  if (rec.command !== undefined && (command === undefined || command.trim() === '')) {
    return fail(`command must be a non-empty string of at most ${MAX_SETUP_COMMAND} characters`);
  }
  const patch = rec.patch === undefined ? undefined : cleanBody(rec.patch, MAX_SETUP_PATCH);
  if (rec.patch !== undefined && patch === undefined) {
    return fail(`patch must be a string of at most ${MAX_SETUP_PATCH} characters`);
  }
  if (command !== undefined && patch !== undefined) return fail('a change proposal carries an exact command OR a patch, never both');
  if (command === undefined && patch === undefined) return fail('a change proposal needs an exact command or patch');
  const path = rec.path;
  if (
    path !== undefined &&
    (typeof path !== 'string' || path.trim() === '' || path.length > MAX_SETUP_PATH || path.replace(ALL_CONTROLS, '') !== path)
  ) {
    return fail(`path must be a non-empty string of at most ${MAX_SETUP_PATH} characters without control characters`);
  }
  const value: ChangeProposal = { kind: 'change', repo, reason };
  if (path !== undefined) value.path = path;
  if (command !== undefined) value.command = command;
  if (patch !== undefined) value.patch = patch;
  if (clears !== undefined) value.clears = clears;
  return { ok: true, value };
}
