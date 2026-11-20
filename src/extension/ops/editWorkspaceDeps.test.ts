import { describe, expect, it } from 'vitest';
import { editWorkspaceDepsOp, planWorkspaceDepsEdit, repoNameOfDepsReason, type WorkspaceDepsEditPlan } from './editWorkspaceDeps.js';

const YAML = ['name: p', 'repositories:', '  web:', '    path: ./web', '  api:', '    path: ./api', '    graphWorkspace:', '      link: [.venv]', 'other: 1', ''].join('\n');

describe('repoNameOfDepsReason', () => {
  it('reads the repository from the block reason', () => {
    expect(repoNameOfDepsReason('graph-workspace-deps: node run 5 (web: no node_modules)')).toBe('web');
    expect(repoNameOfDepsReason('graph-workspace-deps: node run 5')).toBeUndefined();
  });
});

describe('planWorkspaceDepsEdit', () => {
  it('inserts an empty graphWorkspace key under the repository entry', () => {
    expect(planWorkspaceDepsEdit(YAML, 'web')).toEqual({
      found: true,
      revealLine: 3,
      insert: { beforeLine: 3, text: '    graphWorkspace: {}' },
    });
  });
  it('reveals the existing key and inserts nothing', () => {
    expect(planWorkspaceDepsEdit(YAML, 'API')).toEqual({ found: true, revealLine: 6 });
  });
  it('falls back to the repositories section when the entry is missing', () => {
    expect(planWorkspaceDepsEdit(YAML, 'nope')).toEqual({ found: false, revealLine: 1 });
    expect(planWorkspaceDepsEdit('name: p\n', 'web')).toEqual({ found: false, revealLine: 0 });
  });
});

describe('planWorkspaceDepsEdit edge cases', () => {
  it('skips comments and blank lines and uses the child indent of the entry', () => {
    const yaml = ['repositories:', '  # note', '', '  web:', '', '      path: ./web', '      # c', '  api:', '    path: x'].join('\n');
    expect(planWorkspaceDepsEdit(yaml, 'web')).toEqual({
      found: true,
      revealLine: 4,
      insert: { beforeLine: 4, text: '      graphWorkspace: {}' },
    });
  });
  it('indents two spaces under an entry with no children', () => {
    expect(planWorkspaceDepsEdit('repositories:\n  web:\n  api:\n', 'web')).toEqual({
      found: true,
      revealLine: 2,
      insert: { beforeLine: 2, text: '    graphWorkspace: {}' },
    });
  });
  it('reads quoted keys and stops at the next top-level key', () => {
    const q = ['repositories:', '  "web":', "    'graphWorkspace': {}", 'other:', '  web:', '    x: 1'].join('\n');
    expect(planWorkspaceDepsEdit(q, 'web')).toEqual({ found: true, revealLine: 2 });
    expect(planWorkspaceDepsEdit(['repositories:', '  api:', '    x: 1', 'other:', '  web:'].join('\n'), 'web')).toEqual({
      found: false,
      revealLine: 0,
    });
  });
  it('ignores a deeper key that matches the repository name and a graphWorkspace of another entry', () => {
    const y = ['repositories:', '  api:', '    web: 1', '    graphWorkspace: {}', '  web:', '    path: w'].join('\n');
    expect(planWorkspaceDepsEdit(y, 'web')).toEqual({
      found: true,
      revealLine: 5,
      insert: { beforeLine: 5, text: '    graphWorkspace: {}' },
    });
  });
  it('does not match a child key with a larger indent than the first child', () => {
    const y = ['repositories:', '  web:', '    path:', '      graphWorkspace: 1', '  api:'].join('\n');
    expect(planWorkspaceDepsEdit(y, 'web')).toMatchObject({ insert: { beforeLine: 2 } });
  });
  it('falls back when no repository name is given', () => {
    expect(planWorkspaceDepsEdit('repositories:\n  web:\n', undefined)).toEqual({ found: false, revealLine: 0 });
  });
});

describe('planWorkspaceDepsEdit flow style', () => {
  it('inserts nothing into a flow-style entry', () => {
    expect(planWorkspaceDepsEdit('repositories:\n  web: { path: ./web }\n  api:\n    path: x', 'web')).toEqual({
      found: true,
      revealLine: 1,
    });
    expect(planWorkspaceDepsEdit('repositories:\n  web: [a]\n', 'web')).toEqual({ found: true, revealLine: 1 });
  });
});

describe('repoNameOfDepsReason more', () => {
  it('needs the parenthesised repo form', () => {
    expect(repoNameOfDepsReason('graph-workspace-deps: node run 5 (api-2: x)')).toBe('api-2');
    expect(repoNameOfDepsReason('(web) nothing')).toBeUndefined();
  });
});

describe('editWorkspaceDepsOp', () => {
  it('opens karst.yml at the repository and tells the user to save and resume', async () => {
    const opened: Array<[string, WorkspaceDepsEditPlan]> = [];
    const infos: string[] = [];
    await editWorkspaceDepsOp(
      {
        readManifest: () => ({ path: '/p/karst.yml', text: YAML }),
        open: async (path, plan) => void opened.push([path, plan]),
        notify: { info: (m) => void infos.push(m), warn: () => undefined, error: async () => undefined },
      },
      'graph-workspace-deps: node run 5 (web: x)',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]![0]).toBe('/p/karst.yml');
    expect(opened[0]![1].revealLine).toBe(3);
    expect(infos[0]).toBe('Set graphWorkspace for this repository in karst.yml, save the file, then resume the graph.');
  });
  it('opens nothing without a karst.yml', async () => {
    const warns: string[] = [];
    let opened = false;
    await editWorkspaceDepsOp(
      {
        readManifest: () => undefined,
        open: async () => void (opened = true),
        notify: { info: () => undefined, warn: (m) => void warns.push(m), error: async () => undefined },
      },
      '',
    );
    expect(opened).toBe(false);
    expect(warns).toEqual(['No karst.yml exists to edit. Run the setup session first.']);
  });
});
