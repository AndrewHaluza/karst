import { describe, it, expect } from 'vitest';
import { buildPrDescriptionPrompt, sanitizePrDescription } from './prDescription.js';

describe('buildPrDescriptionPrompt', () => {
  it('names the title and forbids preamble, commentary, and a wrapping fence', () => {
    const prompt = buildPrDescriptionPrompt('KAR-1 fix ship');

    expect(prompt).toContain('KAR-1 fix ship');
    expect(prompt.toLowerCase()).toContain('no preamble');
    expect(prompt.toLowerCase()).toContain('do not wrap');
    expect(prompt.toLowerCase()).toContain('markdown');
  });
});

describe('sanitizePrDescription', () => {
  it('unwraps a whole-body code fence that carries a language tag', () => {
    const raw = ['```markdown', '## Summary', '', '- Fixed `shipTicket`.', '```'].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe(
      ['## Summary', '', '- Fixed `shipTicket`.'].join('\n'),
    );
  });

  it('unwraps a whole-body code fence with no language tag', () => {
    const raw = ['```', 'Summary of the change.', '```'].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe('Summary of the change.');
  });

  it('unwraps a doubly wrapped body', () => {
    const raw = ['````', '```markdown', '## Summary', '```', '````'].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe('## Summary');
  });

  it('keeps a fenced code block that is only part of the body', () => {
    const raw = [
      '## Summary',
      '',
      'Run it with:',
      '',
      '```bash',
      'npm test',
      '```',
      '',
      'Done.',
    ].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe(raw);
  });

  it('drops session status chatter about whether a PR exists', () => {
    const raw = [
      'No PR open yet for this branch. Description below (copy-paste ready).',
      '',
      '## Summary',
      '',
      '- Real content.',
    ].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe(
      ['## Summary', '', '- Real content.'].join('\n'),
    );
  });

  it('drops preamble and postamble narration around the description', () => {
    const raw = [
      "Here's the pull request description for these changes:",
      '',
      '## Summary',
      '',
      '- Real content.',
      '',
      'Let me know if you want any changes.',
    ].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe(
      ['## Summary', '', '- Real content.'].join('\n'),
    );
  });

  it('keeps chatter-shaped text that is inside a fenced code block', () => {
    const raw = [
      '## Terminal output',
      '',
      '```text',
      'No PR open yet for this branch. Description below (copy-paste ready).',
      '```',
    ].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe(raw);
  });

  it('collapses runs of blank lines left behind by dropped chatter', () => {
    const raw = ['## Summary', '', '', '', '- Real content.'].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe(
      ['## Summary', '', '- Real content.'].join('\n'),
    );
  });

  it('falls back when the model produced nothing but chatter', () => {
    const raw = ['No PR open yet for this branch.', '(copy-paste ready)'].join('\n');

    expect(sanitizePrDescription(raw, 'KAR-1 fix ship')).toBe('KAR-1 fix ship');
  });

  it('falls back on empty output', () => {
    expect(sanitizePrDescription('   \n\n  ', 'KAR-1 fix ship')).toBe('KAR-1 fix ship');
  });

  it('leaves a clean markdown body untouched', () => {
    const raw = [
      '## Summary',
      '',
      'Ship now sanitizes `describePr` output before it reaches `gh pr create --body`.',
      '',
      '## Changes',
      '',
      '- **`src/workflow/prDescription.ts`** — new module.',
    ].join('\n');

    expect(sanitizePrDescription(raw, 'fallback')).toBe(raw);
  });
});
