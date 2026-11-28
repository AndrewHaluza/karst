import { encodeClaudeProjectDir } from '../claudeTranscriptWatch.js';
import { sshQuote } from './sshQuote.js';

/**
 * The remote half of transcript metering (D556 edit 5).
 *
 * **claude** writes `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` on the
 * remote. The launch makes that project dir a LINK into the remote bridge run
 * dir, so the forwarder can copy the remote file into the host bridge's
 * `claude-projects/` tree where the existing sweep reads it (an ssh placement
 * already resolves its transcript path with `sandboxCwdFor`, `@arch:AC-34`).
 *
 * **codex** has no per-cwd directory (`$CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-<time>-<sessionId>.jsonl`), so a link is not possible. The launch
 * writes the remote repo path into the run dir. At each discovery, the forwarder
 * lists the rollouts whose first line (`session_meta`) names that path, so a
 * rollout that codex creates AFTER the launch is found too. The forwarder
 * follows each one as a second stream into the host bridge's `codex-sessions/`
 * dir, and `codexRolloutWatchLoop` reads that copy for an ssh placement.
 *
 * The remote chooses every file name, so the host validates each path part
 * before it touches the fs: one part is `[A-Za-z0-9._-]{1,200}`, never `.` or
 * `..`, claude at most 2 parts deep, codex at most 4.
 */

export const CLAUDE_PROJECTS_DIRNAME = 'claude-projects';
export const CODEX_SESSIONS_DIRNAME = 'codex-sessions';
/** The remote repo path `codexRolloutDiscoveryScript` writes into the run dir. */
export const CODEX_CWD_FILE = 'codex-cwd.txt';

/** One path part a remote transcript name may use. */
export const TRANSCRIPT_PART_RE = /^[A-Za-z0-9._-]{1,200}$/;

export function isTranscriptPart(part: string): boolean {
  return part !== '.' && part !== '..' && TRANSCRIPT_PART_RE.test(part);
}

/** At most 2 parts below `claude-projects/`, each safe, the last a `.jsonl`. */
export function isClaudeTranscriptRel(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every(isTranscriptPart) && parts[parts.length - 1]!.endsWith('.jsonl');
}

/** A codex rollout path below `sessions/`: at most 4 parts, the last `rollout-*.jsonl`. */
export function isCodexRolloutRel(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.length < 1 || parts.length > 4) return false;
  if (!parts.every(isTranscriptPart)) return false;
  const name = parts[parts.length - 1]!;
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

/**
 * Link `~/.claude/projects/<encoded>` to `<runDir>/claude-projects/<encoded>`.
 * An existing directory is copied into the bridge dir FIRST, so `--resume`
 * keeps reading the same transcript. Idempotent.
 */
export function claudeTranscriptLinkScript(runDir: string, remoteCwd: string): string {
  const project = encodeClaudeProjectDir(remoteCwd);
  if (!isTranscriptPart(project)) throw new Error(`ssh transcript: invalid project dir ${JSON.stringify(project)}`);
  return [
    '# karst-ssh-claude-transcripts',
    'set -e',
    'p="$HOME/.claude/projects"',
    'mkdir -p "$p"',
    `t=${sshQuote(`${runDir}/${CLAUDE_PROJECTS_DIRNAME}/${project}`)}`,
    `d="$p"/${sshQuote(project)}`,
    'mkdir -p "$t"',
    'if [ -L "$d" ]; then [ "$(readlink "$d")" = "$t" ] && exit 0; rm "$d"',
    'elif [ -d "$d" ]; then cp -a "$d"/. "$t"/; rm -rf "$d"; fi',
    'ln -s "$t" "$d"',
  ].join('\n');
}

/**
 * Write the remote repo path into `<runDir>/codex-cwd.txt` (temp + `mv`).
 * The rollout does not exist yet: codex creates it after the launch, so
 * `codexRolloutListScript` finds it at each discovery.
 */
export function codexRolloutDiscoveryScript(runDir: string, remoteCwd: string): string {
  return [
    '# karst-ssh-codex-rollouts',
    'set -e',
    `t=${sshQuote(`${runDir}/${CODEX_CWD_FILE}`)}`,
    `mkdir -p ${sshQuote(runDir)}`,
    `printf '%s\\n' ${sshQuote(remoteCwd)} > "$t.tmp"`,
    'mv -f "$t.tmp" "$t"',
  ].join('\n');
}

/** List the `.jsonl` files below a remote dir, relative (`a/b.jsonl`), at most `maxDepth` deep. */
export function transcriptListScript(remoteDir: string, maxDepth = 2): string {
  return [
    '# karst-ssh-transcripts',
    `d=${sshQuote(remoteDir)}`,
    '[ -d "$d" ] || exit 0',
    'cd "$d" || exit 1',
    `find . -maxdepth ${String(maxDepth)} -type f -name '*.jsonl' 2>/dev/null | sed 's|^\\./||'`,
  ].join('\n');
}

/**
 * Print the rollouts (relative to `$HOME/.codex/sessions`, one per line) whose
 * first line names the repo path that the launch wrote into `cwdFile`. It runs
 * at every discovery, so a rollout created after the launch is listed too.
 */
export function codexRolloutListScript(cwdFile: string): string {
  return [
    '# karst-ssh-codex-list',
    `c=${sshQuote(cwdFile)}`,
    '[ -f "$c" ] || exit 0',
    'r=$(head -n 1 -- "$c")',
    '[ -n "$r" ] || exit 0',
    'd="$HOME/.codex/sessions"',
    '[ -d "$d" ] || exit 0',
    'cd "$d" || exit 1',
    `find . -maxdepth 4 -type f -name 'rollout-*.jsonl' 2>/dev/null | while IFS= read -r f; do`,
    `  if head -n 1 -- "$f" 2>/dev/null | grep -qF -- "$r"; then printf '%s\\n' "\${f#./}"; fi`,
    'done',
  ].join('\n');
}

/** The shell EXPRESSION of one remote codex rollout (HOME is expanded by the remote shell). */
export function codexRolloutExpr(rel: string): string {
  return `"$HOME"/.codex/sessions/${sshQuote(rel)}`;
}
