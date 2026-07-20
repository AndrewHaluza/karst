import { describe, it, expect } from 'vitest';
import { generateProjectSlug, resolveProjectSlug } from './slug.js';

describe('generateProjectSlug', () => {
  it('derives a readable slug from the folder name', () => {
    expect(generateProjectSlug('/Users/nd/Work/projects/karst')).toMatch(/^karst-[a-f0-9]{8}$/);
  });

  it('sanitizes a folder name with spaces and punctuation', () => {
    expect(generateProjectSlug('/tmp/My Project (v2)!')).toMatch(/^my-project-v2-[a-f0-9]{8}$/);
  });

  it('is stable for the same path', () => {
    const path = '/Users/nd/Work/projects/karst';
    expect(generateProjectSlug(path)).toBe(generateProjectSlug(path));
  });

  it('distinguishes two clones of the same repo at different paths', () => {
    const a = generateProjectSlug('/Users/nd/a/karst');
    const b = generateProjectSlug('/Users/nd/b/karst');
    expect(a).not.toBe(b);
    // ...but both stay recognisable as "karst"
    expect(a.startsWith('karst-')).toBe(true);
    expect(b.startsWith('karst-')).toBe(true);
  });

  it('falls back to a bare hash when the folder name sanitizes to nothing', () => {
    expect(generateProjectSlug('/tmp/!!!')).toMatch(/^project-[a-f0-9]{8}$/);
  });

  it('ignores a trailing separator so the same folder yields one slug', () => {
    expect(generateProjectSlug('/tmp/karst/')).toBe(generateProjectSlug('/tmp/karst'));
  });
});

describe('resolveProjectSlug', () => {
  it('prefers the manifest id when set', () => {
    expect(resolveProjectSlug('karst-extension', '/Users/nd/Work/projects/karst')).toBe(
      'karst-extension',
    );
  });

  it('falls back to the path-derived slug for a legacy manifest', () => {
    const root = '/Users/nd/Work/projects/karst';
    expect(resolveProjectSlug(undefined, root)).toBe(generateProjectSlug(root));
  });

  it('sanitizes a hand-authored id so it can never collide with a generated one by accident', () => {
    expect(resolveProjectSlug('My Project!', '/tmp/x')).toBe('my-project');
  });

  it('falls back to the derived slug when the id sanitizes to nothing', () => {
    expect(resolveProjectSlug('!!!', '/tmp/karst')).toBe(generateProjectSlug('/tmp/karst'));
  });
});
