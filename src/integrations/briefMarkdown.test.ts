import { describe, it, expect } from 'vitest';
import { renderBrief } from './briefMarkdown.js';
import type { ContextBrief } from './ticketing.js';

/** A brief carrying only the original five fields. */
function bareBrief(over: Partial<ContextBrief> = {}): ContextBrief {
  return {
    title: 'Fix login',
    description: 'The modal will not close.',
    tags: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

describe('renderBrief backward compatibility', () => {
  it('renders a bare brief byte-identically to the pre-enrichment format', () => {
    const md = renderBrief(bareBrief());
    expect(md).toBe('# Fix login\n\nThe modal will not close.');
  });

  it('keeps tags/comments/attachments exactly where they were', () => {
    const md = renderBrief(
      bareBrief({
        tags: ['bug', 'frontend'],
        comments: [{ author: 'jane', text: 'repro on safari', date: '' }],
      }),
    );
    expect(md).toBe(
      '# Fix login\n\nThe modal will not close.\n\nTags: bug, frontend\n\n## Comments\n- jane: repro on safari',
    );
  });

  it('emits no enrichment headings when the new fields are absent', () => {
    const md = renderBrief(bareBrief());
    for (const h of ['## Details', '## People', '## Relations', '## Dates', '## Links']) {
      expect(md).not.toContain(h);
    }
  });
});

describe('renderBrief enrichment sections', () => {
  it('renders status, priority, milestone, and a safe link under Details', () => {
    const md = renderBrief(
      bareBrief({
        status: 'in review',
        priority: 'urgent',
        milestone: 'Sprint 12',
        url: 'https://app.clickup.com/t/abc?sig=secret',
      }),
    );
    expect(md).toContain('## Details');
    expect(md).toContain('- Status: in review');
    expect(md).toContain('- Priority: urgent');
    expect(md).toContain('- Sprint/Milestone: Sprint 12');
    // Pre-signed query stripped by safeUrl — no credential persisted.
    expect(md).toContain('- Link: https://app.clickup.com/t/abc');
    expect(md).not.toContain('sig=secret');
  });

  it('renders people with role labels and optional email', () => {
    const md = renderBrief(
      bareBrief({
        people: [
          { name: 'jane', role: 'assignee', email: 'jane@x.io' },
          { name: 'bob', role: 'reporter' },
          { name: 'kim', role: 'watcher' },
        ],
      }),
    );
    expect(md).toContain('## People');
    expect(md).toContain('- Assignee: jane <jane@x.io>');
    expect(md).toContain('- Reporter: bob');
    expect(md).toContain('- Watcher: kim');
  });

  it('renders relations with human labels', () => {
    const md = renderBrief(
      bareBrief({
        relations: [
          { kind: 'blocked-by', ref: 'T-1' },
          { kind: 'blocks', ref: 'T-2', title: 'downstream' },
          { kind: 'parent', ref: 'EPIC-9', status: 'open' },
        ],
      }),
    );
    expect(md).toContain('## Relations');
    expect(md).toContain('- Blocked by: T-1');
    expect(md).toContain('- Blocks: T-2 — downstream');
    expect(md).toContain('- Parent: EPIC-9 (open)');
  });

  it('renders present timestamps only, in a fixed order', () => {
    const md = renderBrief(
      bareBrief({
        timestamps: { created: '2024-01-01T00:00:00.000Z', due: '2024-02-01T00:00:00.000Z' },
      }),
    );
    expect(md).toContain('## Dates');
    expect(md).toContain('- Created: 2024-01-01T00:00:00.000Z');
    expect(md).toContain('- Due: 2024-02-01T00:00:00.000Z');
    expect(md).not.toContain('- Updated:');
  });

  it('renders only safe links under Links', () => {
    const md = renderBrief(
      bareBrief({ links: ['https://a.example/doc', 'javascript:alert(1)'] }),
    );
    expect(md).toContain('## Links');
    expect(md).toContain('- https://a.example/doc');
    expect(md).not.toContain('javascript:');
  });

  it('escapes untrusted field content so it cannot break out of its line', () => {
    const md = renderBrief(
      bareBrief({ people: [{ name: 'x](javascript:alert(1))', role: 'assignee' }] }),
    );
    expect(md).not.toContain('](javascript:alert(1))');
  });
});
