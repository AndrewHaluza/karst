/**
 * The onboarding-setup proposal contract — what the setup session's
 * `karst manifest propose` / `karst setup propose-change` commands write into
 * the session outbox and what the host ingests. Pure; the CLI and the host
 * import it, so both sides apply the SAME shape, caps and control stripping.
 *
 * Two kinds, discriminated by `kind`:
 *  - `manifest` — a full proposed `karst.yml`. The host diffs it against the
 *    current file (or the scaffold) and applies it only after the user
 *    approves, always preserving protected identity fields (`id`, agent
 *    settings, presets, processes) in `manifestApply.ts`.
 *  - `change` — a repo change that needs consent (git init, install deps,
 *    create .env). It carries the exact command (or patch) plus a reason; the
 *    extension shows it and applies it only on explicit approval. The agent
 *    NEVER edits tracked files itself.
 *
 * Matching the planning contract: output is JSON, the host is the sole writer
 * of durable state, and the on-disk outbox is a delivery channel — not a trust
 * boundary. Every value is bounded and control characters are stripped before
 * anything is stored or shown.
 */

/** `KARST_SETUP_OUTBOX` names the setup session's outbox, where these land. */
export const SETUP_OUTBOX_ENV = 'KARST_SETUP_OUTBOX';

export const MAX_SETUP_PROPOSAL_BYTES = 512 * 1024;
export const MAX_SETUP_YAML_BYTES = 256 * 1024;
export const MAX_SETUP_SUMMARY = 8 * 1024;
export const MAX_SETUP_REASON = 2 * 1024;
export const MAX_SETUP_COMMAND = 4 * 1024;
export const MAX_SETUP_PATCH = 256 * 1024;
/** Repository names use the same grammar as a manifest repository key. */
export const SETUP_REPO_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export interface ManifestProposal {
  kind: 'manifest';
  /** Absolute path of the `karst.yml` this proposal would replace or create. */
  targetPath: string;
  /** The full proposed YAML text. The host re-validates it before applying. */
  yaml: string;
  /** One-paragraph human summary of what the proposal does (shown in the diff). */
  summary: string;
}

export interface ChangeProposal {
  kind: 'change';
  /** Manifest repository name (or a directory name for a not-yet-registered repo). */
  repo: string;
  /** Why the change is needed, in the user's terms. */
  reason: string;
  /** The exact command to run, when the change is a command. */
  command?: string;
  /** A unified-diff patch, when the change is a file edit (e.g. a new .env). */
  patch?: string;
}

export type SetupProposal = ManifestProposal | ChangeProposal;
export type SetupProposalResult =
  | { ok: true; value: SetupProposal }
  | { ok: false; reason: string };

// C0 (minus \t \n), DEL, C1, and bidi embedding/override/isolate/mark controls.
const BODY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const ALL_CONTROLS = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const fail = (reason: string): SetupProposalResult => ({ ok: false, reason });

function cleanBody(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.length > max) return undefined;
  return v.replace(BODY_CONTROLS, '');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(rec: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  // Every required key present, and no key outside required ∪ optional.
  if (required.some((k) => !(k in rec))) return false;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(rec).every((k) => allowed.has(k));
}

export function validateSetupProposal(raw: unknown): SetupProposalResult {
  if (!isRecord(raw)) return fail('proposal must be a JSON object');
  const kind = raw.kind;
  if (kind === 'manifest') return validateManifestProposal(raw);
  if (kind === 'change') return validateChangeProposal(raw);
  return fail("kind must be 'manifest' or 'change'");
}

function validateManifestProposal(rec: Record<string, unknown>): SetupProposalResult {
  if (!exactKeys(rec, ['kind', 'targetPath', 'yaml', 'summary'], ['kind', 'targetPath', 'yaml', 'summary'])) {
    return fail('manifest proposal keys must be exactly kind, targetPath, yaml, summary');
  }
  const targetPath = rec.targetPath;
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return fail('targetPath must be a non-empty string');
  }
  // A NUL or control char in a path is never legitimate; strip then require the
  // result to be equal so a caller cannot smuggle one through.
  const cleanedPath = targetPath.replace(ALL_CONTROLS, '');
  if (cleanedPath !== targetPath) return fail('targetPath must not contain control characters');

  const yaml = rec.yaml;
  if (typeof yaml !== 'string' || Buffer.byteLength(yaml, 'utf8') > MAX_SETUP_YAML_BYTES) {
    return fail(`yaml must be a string of at most ${MAX_SETUP_YAML_BYTES} bytes`);
  }
  const summary = cleanBody(rec.summary, MAX_SETUP_SUMMARY);
  if (summary === undefined) return fail(`summary must be a string of at most ${MAX_SETUP_SUMMARY} characters`);
  return { ok: true, value: { kind: 'manifest', targetPath: cleanedPath, yaml, summary } };
}

function validateChangeProposal(rec: Record<string, unknown>): SetupProposalResult {
  if (!exactKeys(rec, ['kind', 'repo', 'reason'], ['kind', 'repo', 'reason', 'command', 'patch'])) {
    return fail('change proposal keys must be exactly kind, repo, reason (plus an optional command or patch)');
  }
  const repo = rec.repo;
  if (typeof repo !== 'string' || !SETUP_REPO_NAME.test(repo) || repo === '.' || repo === '..') {
    return fail('repo must be a name matching [A-Za-z0-9._-]{1,64}, not . or ..');
  }
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
  if (command !== undefined && patch !== undefined) {
    return fail('a change proposal carries an exact command OR a patch, never both');
  }
  if (command === undefined && patch === undefined) {
    return fail('a change proposal needs an exact command or patch');
  }
  const value: ChangeProposal = { kind: 'change', repo, reason };
  if (command !== undefined) value.command = command;
  if (patch !== undefined) value.patch = patch;
  return { ok: true, value };
}
