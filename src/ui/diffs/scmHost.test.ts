import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('scm host seam', () => {
  it('never casts through `as any` to write a read-only vscode property', () => {
    // `SourceControl.label` is `readonly` and getter-only at runtime: assigning
    // it throws `Cannot set property label of #<…> which has only a getter`.
    // The cast that allowed it typechecked, so only a source scan catches a
    // reintroduction. See FIX-50.
    const dir = join(process.cwd(), 'src', 'ui', 'diffs');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /\bas any\b/.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
