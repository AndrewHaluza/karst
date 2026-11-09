import { describe, it, expect } from 'vitest';
import { renderBrief, parseBriefSections } from './briefMarkdown.js';
import { PLANNING_BRIEF_HEADING } from '../planning/planningBriefHeading.js';
import type { ContextBrief } from './ticketing.js';

const bare = (over: Partial<ContextBrief> = {}): ContextBrief => ({
  title: 'Fix login',
  description: 'The modal will not close.',
  tags: [],
  comments: [],
  attachments: [],
  ...over,
});

const rich = (): ContextBrief =>
  bare({
    status: 'in review',
    priority: 'urgent',
    milestone: 'Sprint 4',
    url: 'https://jira.example.com/browse/KAR-1?token=secret',
    people: [
      { role: 'assignee', name: 'Ada', email: 'ada@example.com' },
      { role: 'reporter', name: 'Bob' },
    ],
    relations: [
      { kind: 'blocks', ref: 'KAR-2', title: 'Other', status: 'open' },
      { kind: 'parent', ref: 'KAR-9' },
    ],
    timestamps: { created: '2026-01-01', due: '2026-02-01' },
    links: ['https://example.com/a?x=1'],
    tags: ['bug', 'auth'],
    comments: [
      { author: 'Ada', text: 'first line\nsecond line', date: '' },
      { author: 'Bob', text: 'ok', date: '' },
    ],
  });

describe('parseBriefSections', () => {
  it('returns a bare brief as body only, dropping the title line', () => {
    const p = parseBriefSections(renderBrief(bare()));
    expect(p.body).toBe('The modal will not close.');
    expect(p.planning).toBeNull();
    expect([p.details, p.people, p.relations, p.dates, p.links, p.tags, p.comments, p.attachments]).toEqual([[], [], [], [], [], [], [], []]);
  });

  it('round-trips every enrichment section', () => {
    const p = parseBriefSections(renderBrief(rich()));
    expect(p.body).toBe('The modal will not close.');
    expect(p.details).toEqual([
      { label: 'Status', value: 'in review' },
      { label: 'Priority', value: 'urgent' },
      { label: 'Sprint/Milestone', value: 'Sprint 4' },
      { label: 'Link', value: 'https://jira.example.com/browse/KAR-1' },
    ]);
    expect(p.people).toEqual([
      { label: 'Assignee', value: 'Ada <ada@example.com>' },
      { label: 'Reporter', value: 'Bob' },
    ]);
    expect(p.relations).toEqual([
      { label: 'Blocks', value: 'KAR-2 — Other (open)' },
      { label: 'Parent', value: 'KAR-9' },
    ]);
    expect(p.dates).toEqual([
      { label: 'Created', value: '2026-01-01' },
      { label: 'Due', value: '2026-02-01' },
    ]);
    expect(p.links).toEqual(['https://example.com/a']);
    expect(p.tags).toEqual(['bug', 'auth']);
    expect(p.comments).toEqual([
      { author: 'Ada', text: 'first line\nsecond line' },
      { author: 'Bob', text: 'ok' },
    ]);
  });

  it('unescapes inline markdown in rows', () => {
    const p = parseBriefSections(renderBrief(bare({ status: 'a*b_c [x]' })));
    expect(p.details).toEqual([{ label: 'Status', value: 'a*b_c [x]' }]);
  });

  it('reads attachments with link and size', () => {
    const md = renderBrief(
      bare({
        attachments: [
          { name: 'doc.pdf', kind: 'binary', url: 'https://x.test/doc.pdf?sig=1', size: 2048 },
          { name: 'a.txt', kind: 'text', content: 'hello', size: 5 },
          { name: 'gone.png', kind: 'unavailable', url: 'javascript:alert(1)' },
        ],
      } as Partial<ContextBrief>),
    );
    const p = parseBriefSections(md);
    expect(p.attachments).toEqual([
      { name: 'doc.pdf', size: '2.0 KB', url: 'https://x.test/doc.pdf' },
      { name: 'a.txt', size: '5 B' },
      { name: 'gone.png' },
    ]);
  });

  it('keeps unknown headings and prose in the body', () => {
    const p = parseBriefSections(renderBrief(bare({ description: 'Intro\n\n## Steps\n\n1. one\n2. two' })));
    expect(p.body).toBe('Intro\n\n## Steps\n\n1. one\n2. two');
  });

  it('keeps a brief with no known heading entirely in the body', () => {
    expect(parseBriefSections('just text\n\n- a bullet').body).toBe('just text\n\n- a bullet');
  });

  it('puts a planning section on top as the whole brief', () => {
    const md = `${PLANNING_BRIEF_HEADING}\nDo the thing.\n\n## Design constraints\n- @ui:UI-R39\n- 0b5696078a6`;
    const p = parseBriefSections(md);
    expect(p.body).toBe('');
    expect(p.planning).toBe('Do the thing.\n\n## Design constraints\n- @ui:UI-R39\n- 0b5696078a6');
  });

  it('splits a planning section below a fetched brief', () => {
    const md = `${renderBrief(rich())}\n\n${PLANNING_BRIEF_HEADING}\nPlan text.\n\n## Design constraints\n- D400`;
    const p = parseBriefSections(md);
    expect(p.planning).toBe('Plan text.\n\n## Design constraints\n- D400');
    expect(p.body).toBe('The modal will not close.');
    expect(p.tags).toEqual(['bug', 'auth']);
    expect(p.comments).toHaveLength(2);
  });

  it('keeps a design-constraints section outside the planning section in the body', () => {
    const p = parseBriefSections('# T\n\nText\n\n## Design constraints\n- a');
    expect(p.body).toBe('Text\n\n## Design constraints\n- a');
    expect(p.planning).toBeNull();
  });

  it('handles an empty brief', () => {
    expect(parseBriefSections('').body).toBe('');
  });
});
