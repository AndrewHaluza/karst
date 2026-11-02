import { describe, it, expect } from 'vitest';
import { manifest, repo } from '../manifest/fixtures.js';
import type { PorcelainEntry } from '../integrations/git.js';
import {
  partitionPorcelainByExclude,
  resolveShipArtifacts,
  resolveTemplateModel,
  type ShipArtifactTicket,
} from './shipPreview.js';

const ticket: ShipArtifactTicket = {
  type: null,
  model: null,
};

const entry = (path: string, from?: string): PorcelainEntry =>
  from === undefined ? { status: ' M', path } : { status: 'R ', path, from };

describe('partitionPorcelainByExclude', () => {
  it('splits a dirty set by the excluded paths, preserving git order', () => {
    const entries = [
      entry('src/a.ts'),
      entry('dist/out.js'),
      entry('src/b.ts'),
      entry('dist/nested/x.js'),
    ];
    const { commitFiles, excludedFiles } = partitionPorcelainByExclude(entries, [
      'dist/out.js',
      'dist/nested/x.js',
    ]);
    expect(commitFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(excludedFiles).toEqual(['dist/out.js', 'dist/nested/x.js']);
  });

  it('is identity when nothing is excluded', () => {
    expect(partitionPorcelainByExclude([entry('a'), entry('b')], []).commitFiles).toEqual(['a', 'b']);
    expect(partitionPorcelainByExclude([entry('a')], []).excludedFiles).toEqual([]);
  });

  it('commits the SOURCE deletion of a rename whose destination is excluded', () => {
    // `git mv to-move.txt dist/moved.txt` with `dist/**` excluded: the reset
    // restores the destination but the staged source deletion still lands.
    const { commitFiles, excludedFiles } = partitionPorcelainByExclude(
      [entry('dist/moved.txt', 'to-move.txt')],
      ['dist/moved.txt'],
    );
    expect(commitFiles).toEqual(['to-move.txt']);
    expect(excludedFiles).toEqual(['dist/moved.txt']);
  });

  it('commits nothing when BOTH ends of a rename are excluded', () => {
    const { commitFiles } = partitionPorcelainByExclude(
      [entry('dist/b.txt', 'dist/a.txt')],
      ['dist/a.txt', 'dist/b.txt'],
    );
    expect(commitFiles).toEqual([]);
  });

  it('commits the destination of a rename that moves OUT of an excluded dir', () => {
    const { commitFiles } = partitionPorcelainByExclude(
      [entry('outside.txt', 'dist/inside.txt')],
      ['dist/inside.txt'],
    );
    expect(commitFiles).toEqual(['outside.txt']);
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

  it('reports the core and model that actually ran impl over manifest default', () => {
    const m = manifest({ extention: repo() }, { agentProvider: 'opencode2' });
    const ticketWithNullProviders: ShipArtifactTicket = {
      type: null,
      model: null,
      agentProvider: null,
      sessionProvider: null,
      agentPreset: null,
    };
    const withImpl = resolveShipArtifacts({
      manifest: m,
      ticketId: 901,
      key: 'T901',
      title: 'fix something',
      repoName: 'extention',
      ticket: ticketWithNullProviders,
      implRun: { provider: 'claude', model: 'claude-sonnet-5-5' },
    });
    expect(withImpl.context.provider).toBe('claude');
    expect(withImpl.context.model).toBe('claude-sonnet-5-5');

    const withoutImpl = resolveShipArtifacts({
      manifest: m,
      ticketId: 901,
      key: 'T901',
      title: 'fix something',
      repoName: 'extention',
      ticket: ticketWithNullProviders,
    });
    expect(withoutImpl.context.provider).toBe('opencode2');
    expect(withoutImpl.context.model).toBeUndefined();
  });
});

describe('resolveTemplateModel', () => {
  it('prefers the impl run model, then ticket override, then manifest default, then undefined', () => {
    expect(
      resolveTemplateModel({ model: 'opus' }, manifest({}), { model: 'claude-sonnet-5-5' }),
    ).toBe('claude-sonnet-5-5');
    expect(resolveTemplateModel({ model: 'opus' }, manifest({}))).toBe('opus');
    expect(
      resolveTemplateModel({ model: null }, manifest({}, { defaultModel: 'sonnet' })),
    ).toBe('sonnet');
    expect(resolveTemplateModel({ model: null }, manifest({}))).toBeUndefined();
    expect(resolveTemplateModel({ model: '   ' }, undefined)).toBeUndefined();
  });
});
