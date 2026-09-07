import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_ROOT = join(__dirname, '..', '..', '.agents', 'skills');

function findSkillFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name));
}

function hasDuplicateLeadingFrontmatter(content: string): boolean {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return false;

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return false;

  let i = closeIndex + 1;
  while (i < lines.length && lines[i]?.trim() === '') i++;

  return lines[i]?.trim() === '---';
}

describe('skill frontmatter guard', () => {
  const files = findSkillFiles(SKILLS_ROOT);

  it('finds skill files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relative = file.slice(SKILLS_ROOT.length + 1);
    it(`${relative} has exactly one leading frontmatter block`, () => {
      const content = readFileSync(file, 'utf-8');
      expect(hasDuplicateLeadingFrontmatter(content)).toBe(false);
    });
  }
});
