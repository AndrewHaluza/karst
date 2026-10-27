import { describe, it, expect } from 'vitest';
import { stampScaffold } from './scaffoldStamp.js';

describe('stampScaffold', () => {
  it('prepends the id and points the placeholder repoPath at the workspace', () => {
    const out = stampScaffold('repositories:\n  app:\n    repoPath: /__WORKSPACE_ROOT__\n', 'p-1', '/Users/x/ws');
    expect(out).toBe('id: p-1\n\nrepositories:\n  app:\n    repoPath: /Users/x/ws\n');
  });
});
