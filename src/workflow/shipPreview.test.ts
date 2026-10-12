import { describe, it, expect } from 'vitest';
import { manifest, repo } from '../manifest/fixtures.js';
import {
  partitionDirtyByExclude,
  resolveShipArtifacts,
  resolveTemplateModel,
  type ShipArtifactTicket,
} from './shipPreview.js';

const ticket: ShipArtifactTicket = {
  type: null,
  model: null,
};

describe('partitionDirtyByExclude', () => {
  it('splits a dirty set by the excluded paths, preserving git order', () => {
    const dirty = ['src/a.ts', 'dist/out.js', 'src/b.ts', 'dist/nested/x.js'];
    const { commitFiles, excludedFiles } = partitionDirtyByExclude(dirty, [
      'dist/out.js',
      'dist/nested/x.js',
    ]);
    expect(commitFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(excludedFiles).toEqual(['dist/out.js', 'dist/nested/x.js']);
  });

  it('is identity when nothing is excluded', () => {
    const dirty = ['a', 'b'];
    expect(partitionDirtyByExclude(dirty, []).commitFiles).toEqual(['a', 'b']);
    expect(partitionDirtyByExclude(dirty, []).excludedFiles).toEqual([]);
  });
});

describe('resolveShipArtifacts', () => {
  it('falls back to the ticket title when no conventions configure a subject', () => {
    const artifacts = resolveShipArtifacts({
      manifest: manifest({ extention: repo() }),
      ticketId: 7,
      key: 'T7',
      title: 'fix the thing',
      repoName: 'extention',
      ticket,
    });
    expect(artifacts.commitMessage).toBe('fix the thing');
    expect(artifacts.prTitle).toBe('fix the thing');
    expect(artifacts.excludes).toEqual([]);
    expect(artifacts.context.repo).toBe('extention');
    expect(artifacts.context.scope).toBe('extention');
  });

  it('renders the repo override, then the global, then the default, per key', () => {
    const m = manifest(
      {
        alpha: repo({
          conventions: { pullRequestTitle: '[{scope}] {key} {title}' },
          ship: { exclude: ['dist/**'] },
        }),
      },
      { conventions: { commitMessage: '{type}: {title}' } },
    );
    const artifacts = resolveShipArtifacts({
      manifest: m,
      ticketId: 7,
      key: 'T7',
      title: 'Add ship preview',
      repoName: 'alpha',
      ticket: { ...ticket, type: 'feat' },
    });
    // commitMessage: no repo override → global.
    expect(artifacts.commitMessage).toBe('feat: Add ship preview');
    // pullRequestTitle: repo override wins.
    expect(artifacts.prTitle).toBe('[alpha] T7 Add ship preview');
    expect(artifacts.excludes).toEqual(['dist/**']);
    expect(artifacts.context.type).toBe('feat');
  });

  it('names the manifest repository ENTRY, never a local path', () => {
    const m = manifest({ alpha: repo({ repoPath: '/machine/secret/path' }) });
    const artifacts = resolveShipArtifacts({
      manifest: m,
      ticketId: 1,
      key: 'T1',
      title: 't',
      repoName: 'alpha',
      ticket,
    });
    expect(artifacts.context.repo).toBe('alpha');
  });
});

describe('resolveTemplateModel', () => {
  it('prefers the ticket override, then the manifest default, then undefined', () => {
    expect(resolveTemplateModel({ model: 'opus' }, manifest({}))).toBe('opus');
    expect(
      resolveTemplateModel({ model: null }, manifest({}, { defaultModel: 'sonnet' })),
    ).toBe('sonnet');
    expect(resolveTemplateModel({ model: null }, manifest({}))).toBeUndefined();
    expect(resolveTemplateModel({ model: '   ' }, undefined)).toBeUndefined();
  });
});
