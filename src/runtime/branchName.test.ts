import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRANCH_TEMPLATE,
  renderBranchName,
  validateBranchTemplate,
  type BranchTemplateContext,
} from './branchName.js';

const context: BranchTemplateContext = {
  id: 42,
  key: 'PROJ-42',
  title: 'Add search',
  slug: 'proj-42-add-search',
  type: 'feat',
};

describe('validateBranchTemplate', () => {
  it('accepts the branch vocabulary', () => {
    expect(() => validateBranchTemplate('{type}/{slug}')).not.toThrow();
    expect(() => validateBranchTemplate('karst/{key}-{id}-{title}')).not.toThrow();
  });

  // Branch names are per-repository, but a repository entry sharing a repoPath
  // with another resolves to ONE worktree — a repo-dependent branch name would be
  // ambiguous there, so the vocabulary excludes it outright.
  it('rejects the repo-dependent tokens that only artifacts may use', () => {
    expect(() => validateBranchTemplate('{repo}/{slug}')).toThrow(/branchName.*\{repo\}/);
    expect(() => validateBranchTemplate('{scope}/{slug}')).toThrow(/branchName.*\{scope\}/);
    expect(() => validateBranchTemplate('{description}')).toThrow(/branchName.*\{description\}/);
  });

  it('rejects blank and malformed templates', () => {
    expect(() => validateBranchTemplate('   ')).toThrow(/branchName.*blank/);
    expect(() => validateBranchTemplate('karst/{slug')).toThrow(/branchName.*malformed/);
  });

  // Two tickets sharing one branch would have them checking out each other's work.
  it('requires a per-ticket token so two tickets cannot collide on one branch', () => {
    expect(() => validateBranchTemplate('karst/{type}')).toThrow(/branchName.*\{slug\}/);
    expect(() => validateBranchTemplate('karst/{title}')).toThrow(/branchName.*\{slug\}/);
    expect(() => validateBranchTemplate('karst/{type}/{key}')).not.toThrow();
    expect(() => validateBranchTemplate('karst/{id}')).not.toThrow();
  });
});

describe('renderBranchName', () => {
  it('renders the default template when none is configured', () => {
    expect(DEFAULT_BRANCH_TEMPLATE).toBe('karst/{type}/{slug}');
    expect(renderBranchName(undefined, context)).toBe('karst/feat/proj-42-add-search');
    expect(renderBranchName('', context)).toBe('karst/feat/proj-42-add-search');
  });

  it('renders a configured template', () => {
    expect(renderBranchName('{type}/{key}', context)).toBe('feat/proj-42');
  });

  // A substituted value is sanitized BEFORE assembly: a title carrying a slash
  // must not silently invent a path segment the template never asked for.
  it('sanitizes substituted values, never letting them add segments', () => {
    expect(
      renderBranchName('{key}/{title}', { ...context, title: 'fix/auth AND cache' }),
    ).toBe('proj-42/fix-auth-and-cache');
  });

  it('produces a legal ref from hostile input', () => {
    const rendered = renderBranchName('{key}/{title}', {
      ...context,
      title: '..Wild~^:?*[ünïcode] .lock',
    });
    expect(rendered).toMatch(/^[a-z0-9][a-z0-9/_.-]*$/);
    expect(rendered).not.toMatch(/\.\.|\/\/|\.lock$|[/.-]$/);
  });

  it('never renders blank, even when every value sanitizes away', () => {
    expect(renderBranchName('{key}', { ...context, key: '???' })).toBe('42');
  });

  it('caps the length without leaving a trailing separator', () => {
    const rendered = renderBranchName('{key}/{title}', { ...context, title: 'x'.repeat(300) });
    expect(rendered.length).toBeLessThanOrEqual(120);
    expect(rendered).not.toMatch(/[/.-]$/);
  });
});
