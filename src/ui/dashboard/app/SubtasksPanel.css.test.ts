/** Source-text guard: the sub-task T-id is never hidden at any container width (it wraps instead). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SubtasksPanel.css'), 'utf8');

describe('SubtasksPanel.css — narrow widths', () => {
  it('never hides the T-id', () => {
    expect(CSS).not.toMatch(/\.k-id\{display:none\}/);
  });

  it('wraps the row at narrow widths so the T-id keeps its full text', () => {
    expect(CSS).toMatch(/@container \(max-width: 600px\)\{[^@]*\.subtask\{flex-wrap:wrap/);
  });
});
