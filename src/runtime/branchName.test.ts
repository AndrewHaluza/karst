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

describe('placeholder transforms', () => {
  it('shortens a look-alike ticket key to its distinguishing tail', () => {
    expect(
      renderBranchName('karst/{type}/{key|slice:-4}', { ...context, key: '869e82530' }),
    ).toBe('karst/feat/2530');
    expect(
      renderBranchName('karst/{type}/{key|slice:-4}', { ...context, key: '869e820e2' }),
    ).toBe('karst/feat/20e2');
  });

  it('transforms the raw value, then sanitizes the result for git', () => {
    expect(renderBranchName('{key}/{title|truncate:6}', { ...context, title: 'Add search' })).toBe(
      'proj-42/add-s',
    );
  });

  it('a transformed unique variable still satisfies the per-ticket rule', () => {
    expect(() => validateBranchTemplate('karst/{key|slice:-4}')).not.toThrow();
    expect(() => validateBranchTemplate('karst/{title|upper}')).toThrow(
      /must include one of \{slug\}, \{key\} or \{id\}/,
    );
  });

  it('rejects an unknown transform, naming the placeholder', () => {
    expect(() => validateBranchTemplate('karst/{key|slize:-4}')).toThrow(
      /branchName contains unknown transform "slize" in "\{key\|slize:-4\}"/,
    );
  });

  it('rejects a malformed argument, naming the placeholder and the reason', () => {
    expect(() => validateBranchTemplate('karst/{key|slice:x}')).toThrow(
      /branchName has an invalid "slice" argument in "\{key\|slice:x\}": start must be an integer/,
    );
  });

  it('still validates the variable of a transformed placeholder', () => {
    expect(() => validateBranchTemplate('karst/{repo|upper}-{slug}')).toThrow(
      /branchName contains unsupported variable "\{repo\}"/,
    );
  });

  it('a transform that empties every value still never renders blank', () => {
    expect(renderBranchName('{key|slice:0,0}', context)).toBe('42');
  });

  it('renders templates without transforms byte-identically', () => {
    for (const template of ['karst/{type}/{slug}', '{key}-{slug}', 'karst/{slug}', '{id}']) {
      expect(renderBranchName(template, context)).toBe(
        template
          .replace('{type}', 'feat')
          .replace('{slug}', 'proj-42-add-search')
          .replace('{key}', 'proj-42')
          .replace('{id}', '42'),
      );
    }
  });
});
