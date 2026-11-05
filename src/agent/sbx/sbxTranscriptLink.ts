import { encodeClaudeProjectDir, sandboxProjectsDir } from '../claudeTranscriptWatch.js';

/**
 * Runs in the sandbox. `~/.claude/projects` is its own mount there, so only the
 * per-project subdirectory `$2` can become a link to the bridge dir `$1`.
 * A transcript already in the subdirectory is copied over first, so `--resume`
 * keeps working in an existing sandbox. Idempotent.
 */
export const TRANSCRIPT_LINK_SCRIPT = [
  'set -e',
  't="$1"; d="$HOME/.claude/projects/$2"',
  'mkdir -p "$t"',
  'if [ -L "$d" ]; then [ "$(readlink "$d")" = "$t" ] && exit 0; rm "$d"',
  'elif [ -d "$d" ]; then cp -a "$d"/. "$t"/; rm -rf "$d"; fi',
  'ln -s "$t" "$d"',
].join('\n');

/** argv after `sbx exec <name> --`: the link script for the session cwd `cwd`. */
export function transcriptLinkCommand(bridgeDir: string, cwd: string): string[] {
  const project = encodeClaudeProjectDir(cwd);
  return ['sh', '-c', TRANSCRIPT_LINK_SCRIPT, 'karst-link', `${sandboxProjectsDir(bridgeDir)}/${project}`, project];
}
