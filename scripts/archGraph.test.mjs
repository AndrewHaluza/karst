import { describe, expect, it } from 'vitest';
import {
  collapseEdges,
  depcruiseBinFromMain,
  loadLayers,
  nodeId,
  renderMap01,
  renderMap02,
  renderRegions,
  replaceRegion,
  resolveDepcruiseBin,
  srcEntries,
  validateLayers,
} from './archGraph.mjs';

const fixture = {
  modules: [
    {
      source: 'src/extension.ts',
      dependencies: [
        { resolved: 'src/model/time.ts', dependencyTypes: ['local', 'import'] },
        { resolved: 'src/ui/dashboard/state.ts', dependencyTypes: ['local', 'type-only', 'import'] },
        { resolved: 'src/model/thing.test.ts', dependencyTypes: ['local', 'import'] },
      ],
    },
    {
      source: 'src/model/artifacts.ts',
      dependencies: [
        { resolved: 'src/store/tickets.ts', dependencyTypes: ['local', 'import'] },
        { resolved: 'src/model/time.ts', dependencyTypes: ['local', 'import'] },
      ],
    },
    {
      source: 'src/ui/dashboard/state.ts',
      dependencies: [{ resolved: 'src/model/time.ts', dependencyTypes: ['local', 'type-only', 'import'] }],
    },
  ],
};

const layers = {
  entry: ['extension.ts', 'extension'],
  ui: ['ui'],
  agent: ['agent'],
  exec: ['runtime'],
  core: ['model', 'store'],
};

describe('resolveDepcruiseBin', () => {
  it('walks up to the ancestor node_modules a linked worktree inherits', () => {
    const want = '/main/node_modules/dependency-cruiser/bin/dependency-cruiser.mjs';
    const found = resolveDepcruiseBin('/main/.karst/worktrees/t1/scripts', (path) => path === want);
    expect(found).toBe(want);
  });

  it('prefers the nearest node_modules over an ancestor', () => {
    const local = '/main/.karst/worktrees/t1/node_modules/dependency-cruiser/bin/dependency-cruiser.mjs';
    const found = resolveDepcruiseBin('/main/.karst/worktrees/t1', () => true);
    expect(found).toBe(local);
  });

  it('names the missing install when no ancestor carries it', () => {
    expect(() => resolveDepcruiseBin('/main/scripts', () => false)).toThrow(
      /not installed in \/main\/scripts or any ancestor/,
    );
  });
});

describe('validateLayers', () => {
  it('fails every unassigned top-level src entry', () => {
    const errors = validateLayers({ core: ['model'] }, { dirs: ['model', 'ui'], files: ['extension.ts'] });
    expect(errors).toEqual([
      'src entry "extension.ts" is not assigned to any layer',
      'src entry "ui" is not assigned to any layer',
    ]);
  });

  it('fails a layer whose name is also a src directory name', () => {
    const errors = validateLayers({ ui: ['ui'] }, { dirs: ['ui'], files: [] });
    expect(errors).toContain('layer "ui" has the same name as a src directory');
  });

  it('fails a duplicate assignment and an unknown entry', () => {
    const errors = validateLayers(
      { core: ['model', 'nope'], exec: ['model'] },
      { dirs: ['model'], files: [] },
    );
    expect(errors).toContain('layer "core" names unknown src entry "nope"');
    expect(errors).toContain('src entry "model" is assigned to both "core" and "exec"');
  });

  it('assigns every real top-level src entry exactly once', () => {
    const { dirs, files } = srcEntries();
    expect(validateLayers(loadLayers(), { dirs, files })).toEqual([]);
  });
});

describe('depcruiseBinFromMain', () => {
  it('turns the resolved package main into its bin, so an ancestor install works', () => {
    // A worktree has no node_modules of its own; Node resolves the package from
    // the main checkout above it, and the bin must come from THAT install.
    expect(depcruiseBinFromMain('/main/node_modules/dependency-cruiser/src/main/index.mjs')).toBe(
      '/main/node_modules/dependency-cruiser/bin/dependency-cruiser.mjs',
    );
  });
});

describe('collapseEdges', () => {
  it('splits value from type-only and drops intra-entry and test edges', () => {
    const edges = collapseEdges(fixture, layers);
    expect(edges.value).toEqual([
      ['extension.ts', 'model'],
      ['model', 'store'],
    ]);
    expect(edges.type).toEqual([
      ['extension.ts', 'ui', 1],
      ['ui', 'model', 1],
    ]);
  });

  it('is stable across runs', () => {
    const a = renderRegions(fixture, layers);
    const b = renderRegions(fixture, layers);
    expect(a).toEqual(b);
  });
});

describe('renderMap01', () => {
  it('emits one subgraph per layer, sanitized ids and sorted value edges', () => {
    const md = renderMap01(layers, { value: [['extension.ts', 'core'], ['agent', 'core']], type: [] });
    expect(nodeId('extension.ts')).toBe('extension_ts');
    expect(md).toContain('  subgraph agent\n    agent["agent"]\n  end');
    expect(md).toContain('  extension_ts["extension.ts"]');
    expect(md.indexOf('  agent --> core')).toBeLessThan(md.indexOf('  extension_ts --> core'));
  });
});

describe('renderMap02', () => {
  it('renders a sorted type-only table', () => {
    expect(renderMap02({ value: [], type: [['agent', 'core', 3]] })).toBe(
      ['| from | to | files |', '|---|---|---:|', '| agent | core | 3 |'].join('\n'),
    );
  });
});

describe('replaceRegion', () => {
  const text = [
    'hand before',
    '<!-- GENERATED:start id=MAP-01 src=x.mjs -->',
    'old',
    '<!-- GENERATED:end id=MAP-01 -->',
    'hand after',
  ].join('\n');

  it('replaces only the body and is idempotent', () => {
    const once = replaceRegion(text, 'MAP-01', 'new');
    expect(once).toBe(
      [
        'hand before',
        '<!-- GENERATED:start id=MAP-01 src=x.mjs -->',
        'new',
        '<!-- GENERATED:end id=MAP-01 -->',
        'hand after',
      ].join('\n'),
    );
    expect(replaceRegion(once, 'MAP-01', 'new')).toBe(once);
  });

  it('throws when the region is missing or duplicated', () => {
    expect(() => replaceRegion(text, 'MAP-02', 'x')).toThrow(/needs exactly one start and end marker/);
    expect(() => replaceRegion(`${text}\n${text}`, 'MAP-01', 'x')).toThrow(/needs exactly one/);
  });
});
