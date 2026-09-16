import { describe, it, expect } from 'vitest';
import { diffItemShape, type DiffNode } from './treeModel.js';

function node(overrides: Partial<DiffNode> & Pick<DiffNode, 'kind'>): DiffNode {
  return {
    id: 'id',
    label: 'label',
    description: 'description',
    children: [],
    ...overrides,
  };
}

describe('diffItemShape', () => {
  it('maps a selector node', () => {
    expect(diffItemShape(node({ kind: 'selector' }))).toEqual({
      label: 'label',
      description: 'description',
      contextValue: 'karst.diffSelector',
      collapsible: 'none',
      resourcePath: null,
      icon: 'list-selection',
    });
  });

  it('maps a group node', () => {
    expect(diffItemShape(node({ kind: 'group' }))).toEqual({
      label: 'label',
      description: 'description',
      contextValue: 'karst.diffGroup',
      collapsible: 'expanded',
      resourcePath: null,
      icon: null,
    });
  });

  it('maps a repo node', () => {
    expect(diffItemShape(node({ kind: 'repo' }))).toEqual({
      label: 'label',
      description: 'description',
      contextValue: 'karst.diffRepo',
      collapsible: 'expanded',
      resourcePath: null,
      icon: 'repo',
    });
  });

  it('maps a commit node', () => {
    expect(diffItemShape(node({ kind: 'commit' }))).toEqual({
      label: 'label',
      description: 'description',
      contextValue: 'karst.diffCommit',
      collapsible: 'collapsed',
      resourcePath: null,
      icon: 'git-commit',
    });
  });

  it('maps an error node', () => {
    expect(diffItemShape(node({ kind: 'error' }))).toEqual({
      label: 'label',
      description: 'description',
      contextValue: 'karst.diffError',
      collapsible: 'none',
      resourcePath: null,
      icon: 'error',
    });
  });

  it('maps a file node with its absolute path', () => {
    expect(
      diffItemShape(
        node({ kind: 'file', category: 'unstaged', absolutePath: '/wt/repo/src/a.ts' }),
      ),
    ).toEqual({
      label: 'label',
      description: 'description',
      contextValue: 'karst.diffFile.unstaged',
      collapsible: 'none',
      resourcePath: '/wt/repo/src/a.ts',
      icon: null,
    });
  });

  it('keys a file node on its category, offering Unstage only on staged rows', () => {
    const shape = diffItemShape(node({ kind: 'file', category: 'staged' }));
    expect(shape.contextValue).toBe('karst.diffFile.staged');
  });

  it('falls back to a null resource path for a file node with no absolute path', () => {
    const shape = diffItemShape(node({ kind: 'file', category: 'unstaged' }));
    expect(shape.resourcePath).toBeNull();
  });
});
