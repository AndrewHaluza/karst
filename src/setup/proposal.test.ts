import { describe, it, expect } from 'vitest';
import {
  MAX_SETUP_COMMAND,
  MAX_SETUP_WRITE_CONTENT,
  OLD_PROPOSAL_REFUSAL,
  validateChangeProposal,
  validateSetupProposal,
} from './proposal.js';

function ok(raw: unknown) {
  const r = validateSetupProposal(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.value;
}

const reasonOf = (raw: unknown): string => {
  const r = validateSetupProposal(raw);
  if (r.ok) throw new Error('expected a refusal');
  return r.reason;
};

describe('the old proposal kinds', () => {
  it.each([
    [{ kind: 'manifest', targetPath: '/ws/karst.yml', yaml: 'id: x\n', summary: 's' }],
    [{ kind: 'change', repo: 'web', reason: 'deps', command: 'npm ci' }],
  ])('refuses %j with the typed-tools reason', (raw) => {
    expect(reasonOf(raw)).toBe(OLD_PROPOSAL_REFUSAL);
    expect(OLD_PROPOSAL_REFUSAL).toBe('use the typed setup tools');
  });

  it('rejects an unknown kind and a non-object', () => {
    expect(reasonOf({ kind: 'other' })).toContain("'run' or 'write-file'");
    expect(reasonOf([])).toContain('JSON object');
    expect(reasonOf('x')).toContain('JSON object');
  });
});

describe('run proposal', () => {
  const base = { kind: 'run', repo: 'web', purpose: 'install-deps', command: 'npm ci' };

  it('accepts a repo run and a path run, and keeps the fields', () => {
    expect(ok(base)).toEqual(base);
    expect(ok({ kind: 'run', path: '.', purpose: 'git-init', command: 'git init' })).toEqual({
      kind: 'run', path: '.', purpose: 'git-init', command: 'git init',
    });
  });

  it.each(['git-init', 'install-deps', 'create-baseline', 'other'])('accepts the purpose %s', (purpose) => {
    expect(ok({ ...base, purpose })).toMatchObject({ purpose });
  });

  it('refuses a purpose outside the list', () => {
    expect(reasonOf({ ...base, purpose: 'deploy' })).toContain('purpose');
  });

  it('needs a repo or a path', () => {
    const { repo: _repo, ...none } = base;
    expect(reasonOf(none)).toContain('repo or a path');
  });

  it('refuses a bad repo name, . and .., an empty or oversize command, and an extra key', () => {
    expect(reasonOf({ ...base, repo: 'a b' })).toContain('repo');
    expect(reasonOf({ ...base, repo: '..' })).toContain('repo');
    expect(reasonOf({ ...base, command: '   ' })).toContain('command');
    expect(reasonOf({ ...base, command: 'x'.repeat(MAX_SETUP_COMMAND + 1) })).toContain('command');
    expect(reasonOf({ ...base, extra: 1 })).toContain('keys');
  });

  it.each([['', 'empty'], [42, 'not a string'], ['a\u0000b', 'control char'], ['x'.repeat(1025), 'too long']])(
    'refuses path %j (%s)',
    (path, _why) => {
      expect(reasonOf({ ...base, path })).toContain('path');
    },
  );

  it('strips control characters from the command body', () => {
    expect(ok({ ...base, command: 'npm\u0000 ci' })).toMatchObject({ command: 'npm ci' });
  });
});

describe('write-file proposal', () => {
  const base = { kind: 'write-file', repo: 'web', path: 'src/.env.example', content: 'A=1\n' };

  it('accepts a relative path and keeps the content byte for byte', () => {
    expect(ok(base)).toEqual(base);
    expect(ok({ ...base, content: 'a\n\tb' })).toMatchObject({ content: 'a\n\tb' });
  });

  it.each([
    ['/etc/passwd', 'absolute'],
    ['C:/x', 'drive'],
    ['../x', 'parent'],
    ['a/../../x', 'nested parent'],
    ['.karst/karst.yml', 'under .karst'],
    ['a/.KARST/x', 'under .karst, any case'],
    ['.git/hooks/pre-commit', 'under .git'],
    ['', 'empty'],
    ['a\u0000b', 'control char'],
    ['a\\b', 'backslash'],
    ['a b', 'space'],
    ['é.txt', 'non-ascii'],
  ])('refuses the path %j (%s)', (path) => {
    expect(reasonOf({ ...base, path })).toContain('path');
  });

  it('refuses a content that is not text, oversize, or not a string', () => {
    expect(reasonOf({ ...base, content: 'a\u0000b' })).toContain('content');
    expect(reasonOf({ ...base, content: 'x'.repeat(MAX_SETUP_WRITE_CONTENT + 1) })).toContain('content');
    expect(reasonOf({ ...base, content: 5 })).toContain('content');
  });

  it.each(['a\u202Eb', 'a\u0007b', 'a\rb', 'a\u0085b'])('refuses content with the control character %j', (content) => {
    expect(reasonOf({ ...base, content })).toContain('control');
  });
  it('keeps tab and newline in content', () => {
    expect(validateSetupProposal({ ...base, content: 'a\tb\n' }).ok).toBe(true);
  });

  it.each(['.git', '.GIT', '.karst', '.Karst'])('refuses the reserved repo name %s', (repo) => {
    expect(reasonOf({ ...base, repo })).toContain('repo');
    expect(reasonOf({ kind: 'run', repo, purpose: 'other', command: 'ls' })).toContain('repo');
  });

  it('refuses a bad repo and an extra key; the repo is required', () => {
    expect(reasonOf({ ...base, repo: '.' })).toContain('repo');
    expect(reasonOf({ ...base, extra: 1 })).toContain('keys');
    const { repo: _repo, ...none } = base;
    expect(reasonOf(none)).toContain('keys');
  });
});

describe('validateChangeProposal (the host-built form)', () => {
  it('keeps the exact command OR patch rule', () => {
    const ok1 = validateChangeProposal({ kind: 'change', repo: 'web', reason: 'r', command: 'npm ci' });
    expect(ok1.ok).toBe(true);
    expect(validateChangeProposal({ kind: 'change', repo: 'web', reason: 'r' }).ok).toBe(false);
    expect(validateChangeProposal({ kind: 'change', repo: 'web', reason: 'r', command: 'a', patch: 'b' }).ok).toBe(false);
  });
});
