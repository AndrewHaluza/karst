/**
 * Every path karst itself writes into a working tree, as `.git/info/exclude`
 * patterns.
 *
 * Ship commits whatever the worktree holds — `prepareCommitInQuarantine` runs a
 * plain `git add -A`, because a stage marker means the agent believes it is
 * done, not that it ran `git commit`. So anything karst leaves in the tree AND
 * leaves stageable is not inert: it becomes a commit, a push, and a PR whose
 * entire diff is karst's own scaffolding. `hasChangesFrom` cannot catch that —
 * by the time it runs, the scaffolding IS a real diff from the base.
 *
 * These rules cover KARST's own output only. An untracked file the AGENT left
 * behind is caught by a different mechanism — ship's deny scan
 * (`src/workflow/shipDenyScan.ts`), which refuses the repo rather than publish a
 * secret-shaped path.
 *
 * Session cleanup removes the adapter-materialized dirs (`cleanupOwnedPaths`),
 * but only when the session CLOSES, and ship commonly runs while it is still
 * open. Exclusion is the invariant; cleanup is the tidy-up.
 *
 * Ignore rules never apply to tracked files, which is what makes this safe for a
 * repository that checks in its own tree at one of these paths (karst's own
 * carries `.karst-plugin/rpi/` and the `karst-rpi` skill dirs): its changes
 * still show, and the adapters already refuse to claim a pre-existing directory.
 *
 * Every rule is anchored at the working-tree root — unanchored, `.karst/` would
 * also hide a `src/.karst/` that belongs to the repository.
 */
export const KARST_EXCLUDE_RULES: readonly string[] = [
  // Worktrees, server logs, the per-project manifest.
  '/.karst/',
  // ClaudeAdapter's generated plugin dirs (`<id>` + the `karst` orchestrator).
  '/.karst-plugin/',
  // AntigravityAdapter's generated plugin dirs.
  '/.agents/plugins/',
  // CodexAdapter's generated skills. Only the `karst-` prefixed children are
  // karst's — a repository's own skills live beside them under `.agents/skills/`.
  '/.agents/skills/karst-*/',
  // CodexAdapter's per-session config.
  '/.codex/karst/',
  // OpencodeAdapter's generated skills/agents/commands/plugins. Only the
  // `karst-` prefixed children are karst's — a repository's own opencode
  // skills and commands live beside them under `.opencode/`. The plugins AND
  // commands rules carry NO trailing slash: they must match both
  // `karst-<id>/` dirs AND the generated FILEs at those paths (a slash would
  // match directories only, and the unexcluded file was staged by ship's
  // `git add -A`, committed, and conflicted with every worktree's
  // regenerated copy on every merge). Commands now follow the same convention
  // because opencode writes generated command FILES (e.g. `karst-start-task.md`)
  // that ship's `git add -A` would otherwise stage.
  '/.opencode/skills/karst-*/',
  '/.opencode/agents/karst-*/',
  '/.opencode/commands/karst-*',
  '/.opencode/plugins/karst-*',
];
