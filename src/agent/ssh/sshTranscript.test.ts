import { describe, expect, it } from 'vitest';
import { encodeClaudeProjectDir } from '../claudeTranscriptWatch.js';
import {
  CLAUDE_PROJECTS_DIRNAME,
  CODEX_CWD_FILE,
  codexRolloutDiscoveryScript,
  codexRolloutExpr,
  codexRolloutListScript,
  claudeTranscriptLinkScript,
  isClaudeTranscriptRel,
  isCodexRolloutRel,
  isTranscriptPart,
  transcriptListScript,
} from './sshTranscript.js';

/**
 * D556 edit 5: the remote chooses every transcript name, so the names and the
 * remote scripts are the security boundary. A bad part must never reach the fs.
 */

const RUN_DIR = '/srv/karst/karst-0123abcd-7-claude/bridge/7';
const REPO = '/srv/karst/karst-0123abcd-7-claude/repo';

describe('transcript path validation', () => {
  it('accepts the claude shapes the sweep reads: one or two parts below claude-projects', () => {
    expect(isClaudeTranscriptRel('uuid.jsonl')).toBe(true);
    expect(isClaudeTranscriptRel(`${encodeClaudeProjectDir(REPO)}/11111111-1111-4111-8111-111111111111.jsonl`)).toBe(true);
  });

  it('refuses dot-dot, a space, a third part and a non-jsonl last part', () => {
    for (const rel of [
      '../escape.jsonl',
      '..',
      'a/b/c.jsonl',
      'has space/x.jsonl',
      'a/x.txt',
      '',
      '/abs/x.jsonl',
    ]) {
      expect(isClaudeTranscriptRel(rel), rel).toBe(false);
    }
  });

  it('accepts a codex day path and refuses a deeper or wrongly named one', () => {
    expect(isCodexRolloutRel('2026/11/28/rollout-2026-11-28T09-00-00-11111111-1111-4111-8111-111111111111.jsonl')).toBe(true);
    expect(isCodexRolloutRel('rollout-a.jsonl')).toBe(true);
    for (const rel of ['2026/11/28/29/rollout-a.jsonl', '2026/11/28/session-a.jsonl', '..\\x.jsonl', 'a/../b.jsonl']) {
      expect(isCodexRolloutRel(rel), rel).toBe(false);
    }
  });

  it('treats `.` and `..` as unsafe parts even though the character class allows them', () => {
    expect(isTranscriptPart('.')).toBe(false);
    expect(isTranscriptPart('..')).toBe(false);
    expect(isTranscriptPart('a.b-c_1')).toBe(true);
    expect(isTranscriptPart('x'.repeat(201))).toBe(false);
  });
});

describe('remote scripts', () => {
  it('claude links the project dir into the run dir and copies an existing transcript first', () => {
    const script = claudeTranscriptLinkScript(RUN_DIR, REPO);
    const project = encodeClaudeProjectDir(REPO);
    expect(script).toContain(`t='${RUN_DIR}/${CLAUDE_PROJECTS_DIRNAME}/${project}'`);
    expect(script).toContain(`d="$p"/'${project}'`);
    expect(script).toContain('cp -a "$d"/. "$t"/');
    expect(script).toContain('rm -rf "$d"');
    expect(script).toContain('ln -s "$t" "$d"');
  });

  it('codex writes the remote repo path at launch, never a link and never a fixed rollout list', () => {
    const script = codexRolloutDiscoveryScript(RUN_DIR, REPO);
    expect(script).toContain(`t='${RUN_DIR}/${CODEX_CWD_FILE}'`);
    expect(script).toContain(`printf '%s\\n' '${REPO}' > "$t.tmp"`);
    expect(script).toContain('mv -f "$t.tmp" "$t"');
    expect(script).not.toContain('find ');
    expect(script).not.toContain('ln -s');
  });

  it('the codex listing finds the rollouts of this repo at each discovery, by their first line', () => {
    const script = codexRolloutListScript(`${RUN_DIR}/${CODEX_CWD_FILE}`);
    expect(script).toContain(`c='${RUN_DIR}/${CODEX_CWD_FILE}'`);
    expect(script).toContain('r=$(head -n 1 -- "$c")');
    expect(script).toContain('[ -n "$r" ] || exit 0');
    expect(script).toContain('d="$HOME/.codex/sessions"');
    expect(script).toContain(`find . -maxdepth 4 -type f -name 'rollout-*.jsonl'`);
    expect(script).toContain('head -n 1 -- "$f" 2>/dev/null | grep -qF -- "$r"');
  });

  it('the listing scripts stay inside the named dir and print relative names', () => {
    const list = transcriptListScript(`${RUN_DIR}/${CLAUDE_PROJECTS_DIRNAME}`, 2);
    expect(list).toContain(`d='${RUN_DIR}/${CLAUDE_PROJECTS_DIRNAME}'`);
    expect(list).toContain('-maxdepth 2');
    expect(list).toContain("sed 's|^\\./||'");
    expect(codexRolloutExpr('2026/11/28/r.jsonl')).toBe('"$HOME"/.codex/sessions/\'2026/11/28/r.jsonl\'');
  });
});
