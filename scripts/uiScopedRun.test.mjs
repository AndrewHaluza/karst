import { describe, expect, it } from 'vitest';
import { planScopedRun, summarize } from './uiScopedRun.mjs';

describe('planScopedRun', () => {
  it('scopes the visual part to the view and leaves the layout part unscoped', () => {
    const [visual, layout] = planScopedRun('ticketForm', []);
    expect(visual.script).toBe('test:visual:screens:docker');
    expect(visual.env.KARST_UI_GREP).toContain('ticketForm');
    expect(layout.script).toBe('test:layout:docker');
    expect(layout.env.KARST_UI_GREP).toBe('');
  });

  it('rejects an unknown view', () => {
    expect(() => planScopedRun('nope', [])).toThrow(/unknown view "nope"/);
  });
});

describe('summarize', () => {
  it('prints a line per part and fails if either fails', () => {
    const { lines, status } = summarize([
      { name: 'visual', status: 0 },
      { name: 'layout', status: 1 },
    ]);
    expect(lines).toEqual(['test:ui:docker [visual] PASS', 'test:ui:docker [layout] FAIL (exit 1)']);
    expect(status).toBe(1);
  });

  it('passes when all pass', () => {
    expect(summarize([{ name: 'visual', status: 0 }]).status).toBe(0);
  });
});
