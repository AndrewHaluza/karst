import type { RemoteDef } from '../../manifest/types.js';
import type { SshCore } from '../sandboxCores.js';
import {
  mergeClaudeTrust,
  mergeCodexTrustToml,
  trustKeyFor,
} from '../workspaceTrust.js';
import { sshArgv, type SshProcess } from './sshProcess.js';

/**
 * Remote pre-trust (D555, edit 5; `@arch:AC-30`).
 *
 * A karst-owned cwd is pre-trusted on the HOST by `agent/workspaceTrust.ts`.
 * A `mode: direct` session opens in `<ws>/repo` on the REMOTE, and claude's
 * folder-trust dialog ("Do you trust the files in this folder?", default `No,
 * exit`) would kill it there just as it did on the host — with no transcript.
 *
 * The record shapes come from `workspaceTrust.ts`, not from this file: for
 * claude the exact key set and entry come from `mergeClaudeTrust` applied to an
 * empty document, and for codex the exact TOML block comes from
 * `mergeCodexTrustToml` applied to an empty file. The remote script merges that
 * record into the file it finds and writes it ATOMICALLY (same-dir temp +
 * rename), never replacing a file it cannot parse.
 *
 * `remoteCwd` is the remote repository root inside the sandbox; the host has no
 * such tree, so `trustKeysFor`/`trustKeyFor` reduce to exactly that absolute
 * path (the key the CLI records when the launch cwd IS the repo root).
 *
 * Transport: the script goes over stdin (`ssh … sh -c 'node -'`), so no file
 * content, path or key value ever appears on the argv (`ps` on a shared VM).
 *
 * Best-effort, like the host: any failure, including a transport failure,
 * calls `warn` and returns. It never throws and never blocks the launch — the
 * launch-exit detection reports the real failure.
 */

/** The step writes nothing to stdout; anything larger than this is a broken remote. */
export const SSH_TRUST_MAX_STDOUT_BYTES = 8 * 1024;

export interface RemoteTrustInput {
  readonly ssh: SshProcess;
  readonly remote: RemoteDef;
  /** The ControlMaster socket dir (D554, Part A.2), already verified private. */
  readonly controlDir: string;
  readonly core: SshCore;
  /** The remote repository root the agent opens in (`<ws>/repo`). */
  readonly remoteCwd: string;
  /** Only for the warning text; a remote definition carries no name. */
  readonly remoteName?: string;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
  readonly signal?: AbortSignal;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `realpath, else realpath(dir)+basename` resolution shared by both scripts. */
const REALPATH_JS = String.raw`
function targetOf(file) {
  try { return fs.realpathSync(file); } catch (e) {
    try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch (e2) { return file; }
  }
}`;

/**
 * The remote claude merge. `keys` is derived host-side from the pure merge, so
 * the record shape cannot drift from `@arch:AC-30`. The merge itself is the
 * same shallow one: keep every other top-level key and every other field of the
 * project entry.
 */
function claudeScript(keys: readonly string[]): string {
  return String.raw`const fs = require('node:fs');
const path = require('node:path');
const keys = ${JSON.stringify(keys)};
${REALPATH_JS}
const file = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(process.env.HOME || '', '.claude.json');
let text = null;
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') process.exit(0); }
let doc = {};
if (text !== null && text.trim() !== '') {
  try { doc = JSON.parse(text); } catch (e) { process.exit(0); }
}
if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) process.exit(0);
const projects = doc.projects && typeof doc.projects === 'object' && !Array.isArray(doc.projects) ? doc.projects : {};
let changed = false;
for (const key of keys) {
  const entry = projects[key] && typeof projects[key] === 'object' && !Array.isArray(projects[key]) ? projects[key] : {};
  if (entry.hasTrustDialogAccepted === true) continue;
  projects[key] = Object.assign({}, entry, { hasTrustDialogAccepted: true });
  changed = true;
}
if (!changed) process.exit(0);
doc.projects = projects;
const target = targetOf(file);
fs.mkdirSync(path.dirname(target), { recursive: true });
const tmp = target + '.karst-trust-' + process.pid + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, target);
`;
}

/**
 * The remote codex merge. `block` (the header plus `trust_level = "trusted"`)
 * comes from the pure merge (`mergeCodexTrustToml` on an empty file); the scan
 * accepts both TOML string styles so an existing table is never duplicated (a
 * redefined table is a parse error for codex).
 */
function codexScript(key: string, block: string): string {
  return String.raw`const fs = require('node:fs');
const path = require('node:path');
const key = ${JSON.stringify(key)};
const block = ${JSON.stringify(block)};
${REALPATH_JS}
const dir = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const file = path.join(dir, 'config.toml');
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') process.exit(0); }
const lines = text.split('\n');
const escaped = JSON.stringify(key).slice(1, -1);
const isHeader = (line) => {
  const m = /^\s*\[\s*projects\s*\.\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*\]\s*(?:#.*)?$/.exec(line);
  return m !== null && (m[1] === escaped || m[2] === key);
};
const at = lines.findIndex(isHeader);
let next;
if (at === -1) {
  const base = text.replace(/\s+$/, '');
  next = (base === '' ? '' : base + '\n\n') + block;
} else {
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) { if (/^\s*\[/.test(lines[i])) { end = i; break; } }
  let trust = -1;
  for (let i = at + 1; i < end; i++) { if (/^\s*trust_level\s*=/.test(lines[i])) { trust = i; break; } }
  if (trust === -1) {
    next = lines.slice(0, at + 1).concat(['trust_level = "trusted"'], lines.slice(at + 1)).join('\n');
  } else if (/^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$/.test(lines[trust])) {
    process.exit(0);
  } else {
    const copy = lines.slice();
    copy[trust] = 'trust_level = "trusted"';
    next = copy.join('\n');
  }
}
const target = targetOf(file);
fs.mkdirSync(path.dirname(target), { recursive: true });
const tmp = target + '.karst-trust-' + process.pid + '.tmp';
fs.writeFileSync(tmp, next, { mode: 0o600 });
fs.renameSync(tmp, target);
`;
}

/** The remote node program for a core, or `undefined` for a core with no folder-trust prompt. */
function trustScript(core: SshCore, remoteCwd: string): string | undefined {
  if (core === 'claude') {
    const merged = mergeClaudeTrust(undefined, remoteCwd).next;
    const projects = (merged as { projects?: Record<string, unknown> }).projects ?? {};
    return claudeScript(Object.keys(projects));
  }
  if (core === 'codex') {
    return codexScript(
      trustKeyFor(remoteCwd),
      mergeCodexTrustToml('', remoteCwd).text,
    );
  }
  return undefined;
}

function describeFailure(input: RemoteTrustInput, detail: string): string {
  const where = input.remoteName === undefined ? input.core : `${input.core} on '${input.remoteName}'`;
  return `ssh trust: ${where} folder trust not recorded (${detail}) — launch continues`;
}

/**
 * Record the remote folder trust for `input.core` in `<ws>/repo`. No-op for a
 * core without a trust prompt (`opencode`, `opencode2`). Never throws.
 */
export async function ensureRemoteWorkspaceTrusted(input: RemoteTrustInput): Promise<void> {
  const script = trustScript(input.core, input.remoteCwd);
  if (script === undefined) return;
  try {
    const result = await input.ssh.runWithStdin(
      sshArgv(input.remote, input.controlDir, 'node -'),
      Buffer.from(script, 'utf8'),
      { maxStdoutBytes: SSH_TRUST_MAX_STDOUT_BYTES, ...(input.signal ? { signal: input.signal } : {}) },
    );
    if (result.code !== 0) {
      const detail = result.transport === true ? `ssh transport failed: ${result.stderr.trim()}` : `exit ${String(result.code)}`;
      input.warn?.(describeFailure(input, detail));
      return;
    }
    input.debug?.(`ssh trust: ${input.core} folder trust recorded for ${input.remoteCwd}`);
  } catch (error) {
    input.warn?.(describeFailure(input, describeError(error)));
  }
}
