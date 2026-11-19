import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { hasBodyControls, MAX_SETUP_WRITE_CONTENT, writeFilePathProblem } from './proposal.js';

/**
 * The host's own patch for a `setup write-file` request. The agent gives a
 * relative path and the whole new content; the HOST builds the diff, so the
 * agent never writes patch text. The patch is then checked with
 * `git apply --check`, shown to the user, and applied only on consent.
 *
 * Path safety is checked on the real disk, not on the text of the path: no
 * existing component below the repo may be a symlink, and the resolved target
 * must stay inside the real repo directory. The `.karst/` and `.git/` names
 * are refused by `writeFilePathProblem`.
 */

export type WriteFilePatch = { ok: true; patch: string } | { ok: false; reason: string };

const fail = (reason: string): WriteFilePatch => ({ ok: false, reason });

type Kind = 'missing' | 'file' | 'symlink' | 'other';

function kindOf(path: string): Kind {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return 'symlink';
    return st.isFile() ? 'file' : 'other';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw e;
  }
}

/** The first problem with the on-disk path, as a refusal reason; undefined when the path is safe to write. */
function diskProblem(realRepo: string, segments: readonly string[]): string | undefined {
  let current = realRepo;
  for (const [i, segment] of segments.entries()) {
    current = join(current, segment);
    const kind = kindOf(current);
    if (kind === 'missing') return undefined; // the rest does not exist: the apply creates it
    if (kind === 'symlink') return `"${segments.slice(0, i + 1).join('/')}" is a symlink; write-file never follows a symlink`;
    if (i < segments.length - 1 && kind !== 'other') return `"${segments.slice(0, i + 1).join('/')}" is a file, not a directory`;
  }
  return undefined;
}

/** Splits text into lines that keep no newline; `final` is false when the text lacks a final newline. */
function linesOf(text: string): { lines: string[]; final: boolean } {
  if (text === '') return { lines: [], final: true };
  const final = text.endsWith('\n');
  const lines = (final ? text.slice(0, -1) : text).split('\n');
  return { lines, final };
}

function range(start: number, count: number): string {
  // A unified range omits the count when it is 1; an empty side starts at 0.
  if (count === 0) return '0,0';
  return count === 1 ? String(start) : `${start},${count}`;
}

function hunk(side: { lines: string[]; final: boolean }, mark: '-' | '+'): string {
  if (side.lines.length === 0) return '';
  const body = side.lines.map((l) => `${mark}${l}\n`).join('');
  return side.final ? body : `${body}\\ No newline at end of file\n`;
}

/**
 * Reads at most `MAX_SETUP_WRITE_CONTENT` bytes through one descriptor that does not follow a
 * symlink, so a file swapped in after the checks cannot give an unbounded read.
 */
function readText(path: string): { text: string } | { problem: string } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return { problem: 'is not a regular file' };
    const buf = Buffer.alloc(MAX_SETUP_WRITE_CONTENT + 1);
    let length = 0;
    while (length < buf.length) {
      const n = readSync(fd, buf, length, buf.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > MAX_SETUP_WRITE_CONTENT) return { problem: `is larger than ${MAX_SETUP_WRITE_CONTENT} bytes; write-file replaces small text files only` };
    const bytes = buf.subarray(0, length);
    if (bytes.includes(0)) return { problem: 'is not a text file; write-file replaces text files only' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { problem: 'is not a text file; write-file replaces text files only' };
    }
  } finally {
    closeSync(fd);
  }
}

/** Builds the patch that makes `path` (relative to `repoDir`) hold exactly `content`. */
export function buildWriteFilePatch(repoDir: string, path: string, content: string): WriteFilePatch {
  try {
    return buildChecked(repoDir, path, content);
  } catch (e) {
    // A disk error must refuse this one proposal; a throw would stop the whole outbox scan.
    const code = (e as NodeJS.ErrnoException).code;
    return fail(`"${path}" cannot be checked on disk${code !== undefined ? ` (${code})` : ''}`);
  }
}

function buildChecked(repoDir: string, path: string, content: string): WriteFilePatch {
  const problem = writeFilePathProblem(path);
  if (problem !== undefined) return fail(problem);
  if (hasBodyControls(content)) return fail('content holds control or bidi characters; write-file writes plain text only');
  let realRepo: string;
  try {
    realRepo = realpathSync(repoDir);
  } catch {
    return fail(`the repo directory ${repoDir} does not exist`);
  }
  // The repo directory must not be inside `.git`, nor be `.karst` itself. A ticket worktree
  // lives below `.karst/worktrees/`, so a `.karst` further up is fine; the P2 guard covers karst.yml.
  const parts = realRepo.split(sep);
  if (parts.some((part) => part.toLowerCase() === '.git') || parts[parts.length - 1]?.toLowerCase() === '.karst') {
    return fail(`the repo directory ${repoDir} is inside .git or is .karst`);
  }
  const segments = path.split('/');
  const bad = diskProblem(realRepo, segments);
  if (bad !== undefined) return fail(bad);
  const target = join(realRepo, ...segments);
  if (!target.startsWith(realRepo + sep)) return fail(`path "${path}" is outside the repo`);
  const header = `diff --git a/${path} b/${path}\n`;
  const exists = kindOf(target) !== 'missing';
  if (!exists) {
    const added = linesOf(content);
    if (added.lines.length === 0) return { ok: true, patch: `${header}new file mode 100644\n` };
    const hunkHead = `@@ -0,0 +${range(1, added.lines.length)} @@\n`;
    return { ok: true, patch: `${header}new file mode 100644\n--- /dev/null\n+++ b/${path}\n${hunkHead}${hunk(added, '+')}` };
  }
  if (kindOf(target) !== 'file') return fail(`"${path}" is not a regular file`);
  const read = readText(target);
  if ('problem' in read) return fail(`"${path}" ${read.problem}`);
  const old = read.text;
  if (old.includes('\r')) return fail(`"${path}" uses CRLF line endings; write-file cannot replace it`);
  if (old === content) return fail(`"${path}" already has this content`);
  const before = linesOf(old);
  const after = linesOf(content);
  const hunkHead = `@@ -${range(1, before.lines.length)} +${range(1, after.lines.length)} @@\n`;
  const patch = `${header}--- a/${path}\n+++ b/${path}\n${hunkHead}${hunk(before, '-')}${hunk(after, '+')}`;
  // The host strips controls from a patch before it checks it; a patch with one would check one text and apply another.
  if (hasBodyControls(patch)) return fail(`"${path}" holds control or bidi characters; write-file replaces plain text files only`);
  return { ok: true, patch };
}
