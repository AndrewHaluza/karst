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
      insert: { beforeLine: 3, text: '    graphWorkspace:' },
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
    expect(infos[0]).toContain('Resume');
  });
  it('opens nothing without a karst.yml', async () => {
    const infos: string[] = [];
    let opened = false;
    await editWorkspaceDepsOp(
      {
        readManifest: () => undefined,
        open: async () => void (opened = true),
        notify: { info: (m) => void infos.push(m), warn: () => undefined, error: async () => undefined },
      },
      '',
    );
    expect(opened).toBe(false);
    expect(infos).toHaveLength(1);
  });
});
