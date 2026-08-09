import { describe, expect, it } from 'vitest';
import { renderPrDescription } from './prDescription.js';

describe('renderPrDescription', () => {
  it('renders a useful body without invoking an agent', () => {
    expect(renderPrDescription({
      title: 'KAR-1 fix ship',
      commits: 'abc1234 fix the ship context\ndef5678 add coverage',
      diffStat: ' src/workflow/ship.ts | 8 +++++---\n 1 file changed',
    })).toBe([
      '## Summary',
      '',
      'KAR-1 fix ship',
      '',
      '## Changes',
      '',
      '- fix the ship context',
      '- add coverage',
      '',
      '## Changed files',
      '',
      '```text',
      ' src/workflow/ship.ts | 8 +++++---',
      ' 1 file changed',
      '```',
    ].join('\n'));
  });

  it('labels truncated sections honestly', () => {
    const body = renderPrDescription({
      title: 'KAR-1',
      commits: 'abc1234 fix',
      commitsTruncated: true,
      diffStat: 'a.ts | 1 +',
      diffStatTruncated: true,
    });
    expect(body).toContain('## Changes (truncated)');
    expect(body).toContain('## Changed files (truncated)');
  });

  it('falls back to the final PR title when git metadata is unavailable', () => {
    expect(renderPrDescription({ title: '[KAR-1] fix ship' })).toBe('[KAR-1] fix ship');
  });
});
