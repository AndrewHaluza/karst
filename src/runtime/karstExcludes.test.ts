import { describe, it, expect } from 'vitest';
import { sep } from 'node:path';
import { KARST_EXCLUDE_RULES } from './karstExcludes.js';
import { OWNED_PREFIXES } from '../agent/materializedCleanup.js';

/**
 * Turn a `.git/info/exclude` pattern into the path prefix it matches, in the
 * shape `materializedCleanup` compares against. Only the two forms this list
 * uses are handled — a rule shaped like anything else is a drift the coverage
 * assertion below should surface rather than silently normalize away. A
 * trailing star-slash (directory-only rule) and a trailing star (file-or-dir
 * rule) are both globs, so the literal `*` is stripped from the fixed prefix.
 */
function prefixOf(rule: string): string {
  const body = rule
    .replace(/^\//u, '')
    .replace(/\*\/$/u, '')
    .replace(/\*$/u, '');
  return `${sep}${body.split('/').join(sep)}`;
}

describe('karst exclude rules', () => {
  it('anchors every rule at the working-tree root', () => {
    for (const rule of KARST_EXCLUDE_RULES) {
      // Unanchored, a pattern like `.karst/` would also hide a `src/.karst/`
      // the repository owns. Every rule karst writes is about ITS path, at the
      // root, and nothing else.
      expect(rule.startsWith('/')).toBe(true);
    }
  });

  it('covers every path session cleanup is allowed to delete', () => {
    // The two lists are halves of one rule: cleanup may only remove a path karst
    // wrote, and every path karst wrote must be unstageable — otherwise ship
    // commits it before cleanup ever runs and the PR carries karst's own
    // scaffolding instead of code. Coverage is one-directional on purpose: the
    // exclude list is a superset (`/.karst/` is excluded but must never be a
    // deletable prefix — it holds the worktrees themselves).
    for (const owned of OWNED_PREFIXES) {
      const covered = KARST_EXCLUDE_RULES.some((rule) => owned.startsWith(prefixOf(rule)));
      expect(covered, `no exclude rule covers ${owned}`).toBe(true);
    }
  });

  it('excludes generated opencode command FILES', () => {
    const file = `${sep}.opencode${sep}commands${sep}karst-start-task.md`;
    const covered = KARST_EXCLUDE_RULES.some((rule) => file.startsWith(prefixOf(rule)));
    expect(covered, `no exclude rule covers the generated command file ${file}`).toBe(true);
  });

  it('does not exclude a repository\'s own opencode commands', () => {
    const file = `${sep}.opencode${sep}commands${sep}mine.md`;
    const covered = KARST_EXCLUDE_RULES.some((rule) => file.startsWith(prefixOf(rule)));
    expect(covered, `exclude rule should not cover a repo-owned command ${file}`).toBe(false);
  });

  it('covers the FILE an adapter generates directly, not only directories', () => {
    // `/.opencode/plugins/karst-*/` (trailing slash) excludes DIRECTORIES only,
    // and OpencodeAdapter's karst-bridge is a FILE at that path — so it stayed
    // stageable, ship's `git add -A` committed it with a baked-in session
    // endpoint, and every later worktree's regenerated copy conflicted with the
    // tracked one on every merge. The literal generated paths must each be
    // covered by some rule, exactly as the adapter writes them.
    const generatedFiles = [
      `${sep}.opencode${sep}plugins${sep}karst-bridge.js`,
    ] as const;
    for (const file of generatedFiles) {
      const covered = KARST_EXCLUDE_RULES.some((rule) => file.startsWith(prefixOf(rule)));
      expect(covered, `no exclude rule covers the generated file ${file}`).toBe(true);
    }
  });
});
