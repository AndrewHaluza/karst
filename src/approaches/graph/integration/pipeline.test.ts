/**
 * Pure helpers of the completion pipeline (T1331). No git process runs here.
 */

import { describe, it, expect } from 'vitest';
import { ignoredPathsFromAddStderr } from './pipeline.js';

const HEADER = 'The following paths are ignored by one of your .gitignore files:';

describe('ignoredPathsFromAddStderr', () => {
  it('reads the paths between the header and the hint lines', () => {
    const stderr = [
      HEADER,
      '.agents/skills/karst-demo',
      'src/generated/out.txt',
      'hint: Use -f if you really want to add them.',
      'hint: Disable this message with "git config set advice.addIgnoredFile false"',
      '',
    ].join('\n');

    expect(ignoredPathsFromAddStderr(stderr)).toEqual([
      '.agents/skills/karst-demo',
      'src/generated/out.txt',
    ]);
  });

  it('stops at a blank line when git prints no hint', () => {
    expect(ignoredPathsFromAddStderr(`${HEADER}\n.agents/skills/karst-demo\n\nfoo`)).toEqual([
      '.agents/skills/karst-demo',
    ]);
  });

  it('returns no paths for other stderr', () => {
    expect(ignoredPathsFromAddStderr('fatal: forced add refusal\n')).toEqual([]);
    expect(ignoredPathsFromAddStderr('')).toEqual([]);
    // A header line alone names nothing.
    expect(ignoredPathsFromAddStderr(`${HEADER}\n`)).toEqual([]);
  });
});
