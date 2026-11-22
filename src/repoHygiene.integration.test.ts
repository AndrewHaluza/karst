import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 40b6ac6 accidentally committed `node_modules` as a symlink pointing at its
// own path (`/Users/nd/Work/projects/karst/node_modules`). The repo's gitignore
// carried `node_modules/`, and a trailing-slash pattern matches only REAL
// directories — git treats a symlink as a file for ignore matching — so a plain
// `git add -A` swept the link into the commit. Every checkout of develop then
// carried a self-referential `node_modules`, and any npm spawn from it died
// with `ELOOP: too many symbolic links encountered` — `./scripts/
// install-local.sh cursor` failed right after printing the `npm run build`
// banner (npm could not even spawn its script shell).
//
// The ignore patterns therefore carry NO trailing slash (they then match a
// real directory AND a symlink of that name), and the tests below pin both the
// patterns and the tracked-symlink inventory so the same accident fails a
// suite instead of shipping.
const repoRoot = join(import.meta.dirname, '..');

describe('repo hygiene: dependency dirs are ignored even as symlinks', () => {
  const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');

  it.each(['node_modules', 'dist', 'coverage'])('%s ignore pattern must not end in "/"', (dir) => {
    const line = gitignore.split('\n').find((l) => l.trim() === dir || l.trim() === `${dir}/`);
    expect(line, `.gitignore has no ignore line for ${dir}`).toBeDefined();
    expect(
      line!.trim().endsWith('/'),
      `${dir}/ matches only a real directory, never a symlink of that name`,
    ).toBe(false);
  });

  // Two kinds of tracked symlink are intentional: AGENTS.md -> CLAUDE.md, and a
  // repository skill mirror `.agents/skills/<name>` -> `../../.claude/skills/<name>`
  // (Codex and Antigravity read `.agents/skills/`, Claude reads `.claude/skills/`;
  // the link keeps one source and reaches every ticket worktree). Any other
  // symlink, or a mirror that points anywhere else, is the accident above.
  it('tracked symlinks are only AGENTS.md -> CLAUDE.md and .agents/skills mirrors of .claude/skills', () => {
    const r = spawnSync('git', ['ls-files', '-s'], { cwd: repoRoot, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const entries = r.stdout
      .split('\n')
      .filter((line) => line.startsWith('120000'))
      .map((line) => {
        const [meta = '', path = ''] = line.split('\t');
        return { path, sha: meta.split(' ')[1] ?? '' };
      });
    expect(entries.map((e) => e.path)).toContain('AGENTS.md');
    for (const { path, sha } of entries) {
      const blob = spawnSync('git', ['cat-file', '-p', sha], { cwd: repoRoot, encoding: 'utf8' });
      expect(blob.status, `git cat-file failed for ${path}`).toBe(0);
      const target = blob.stdout;
      const skill = /^\.agents\/skills\/([a-z0-9][a-z0-9._-]*)$/.exec(path)?.[1];
      const expected = path === 'AGENTS.md' ? 'CLAUDE.md' : skill ? `../../.claude/skills/${skill}` : undefined;
      expect(expected, `unexpected tracked symlink ${path} -> ${target}`).toBeDefined();
      expect(target, `${path} must point at ${expected}`).toBe(expected);
      if (skill) {
        expect(
          existsSync(join(repoRoot, '.claude', 'skills', skill, 'SKILL.md')),
          `${path} mirrors a skill with no .claude/skills/${skill}/SKILL.md`,
        ).toBe(true);
      }
    }
  });
});
