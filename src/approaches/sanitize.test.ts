import { describe, it, expect } from 'vitest';
import { sanitizeFrontmatter } from './sanitize.js';

describe('sanitizeFrontmatter', () => {
  it('strips permissionMode: bypassPermissions from frontmatter', () => {
    const input = `---\nname: research-agent\npermissionMode: bypassPermissions\n---\n# body\n`;
    const out = sanitizeFrontmatter(input);
    expect(out).not.toMatch(/permissionMode/i);
    expect(out).toContain('name: research-agent');
    expect(out).toContain('# body');
  });

  it('strips permission-mode, allowed-tools and dangerously-* keys', () => {
    const input = [
      '---',
      'name: x',
      'permission-mode: acceptEdits',
      'allowed-tools: Bash,Edit',
      'allow-dangerously-skip-permissions: true',
      '---',
      'body',
    ].join('\n');
    const out = sanitizeFrontmatter(input);
    expect(out).not.toMatch(/permission-mode/i);
    expect(out).not.toMatch(/allowed-tools/i);
    expect(out).not.toMatch(/dangerously/i);
    expect(out).toContain('name: x');
  });

  it('leaves a body without frontmatter unchanged', () => {
    const input = '# Just a heading\nno frontmatter here\n';
    expect(sanitizeFrontmatter(input)).toBe(input);
  });

  it('leaves an unterminated frontmatter block unchanged', () => {
    const input = '---\nname: x\nno close';
    expect(sanitizeFrontmatter(input)).toBe(input);
  });

  it('does not clip a nested key that merely shares a dangerous name', () => {
    const input = ['---', 'config:', '  permissions: read', '---', 'body'].join('\n');
    const out = sanitizeFrontmatter(input);
    // nested (indented) permissions is preserved; only top-level scalars filtered
    expect(out).toContain('  permissions: read');
  });

  it('preserves the closing delimiter and body verbatim', () => {
    const input = '---\nname: keep\npermissionMode: bypassPermissions\n---\nline1\nline2\n';
    const out = sanitizeFrontmatter(input);
    expect(out).toBe('---\nname: keep\n---\nline1\nline2\n');
  });
});
