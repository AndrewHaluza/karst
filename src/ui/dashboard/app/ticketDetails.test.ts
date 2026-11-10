import { describe, expect, it } from 'vitest';
import type { DashboardState } from '../state.js';
import { buildTicketDetails as build } from './ticketDetails.js';
import { ticketDataText } from './overlayStack.js';

const buildTicketDetails = (s: DashboardState) => build(s, ticketDataText(s));
import { renderBrief } from '../../../integrations/briefMarkdown.js';

const state = (over: Record<string, unknown> = {}): DashboardState =>
  ({
    ticketId: 7, idLabel: 'T7', key: 'FEAT-7', title: 'Seven', provider: null, ticketUrl: null, brief: null, description: null,
    briefSource: { kind: 'manual' }, origin: null, subtaskParent: null, priority: null, approach: null, worktrees: [], ...over,
  }) as unknown as DashboardState;

const brief = renderBrief({
  title: 'Seven', description: 'Body text', tags: ['bug'], comments: [{ author: 'Ada', text: 'hi', date: '' }], attachments: [],
  status: 'open', people: [{ role: 'assignee', name: 'Ada' }],
});

describe('buildTicketDetails', () => {
  it('has no tabs and is empty without a brief or description', () => {
    const v = buildTicketDetails(state());
    expect(v.empty).toBe(true);
    expect(v.tabs).toEqual([]);
  });

  it('shows a description-only ticket as Description plus As sent to agent', () => {
    const v = buildTicketDetails(state({ description: 'Fix it' }));
    expect(v.tabs.map((t) => t.label)).toEqual(['Description', 'As sent to agent']);
    expect(v.main).toBe('Fix it');
    expect(v.original).toBeNull();
  });

  it('shows the Original description tab only when it differs from the brief', () => {
    const same = buildTicketDetails(state({ brief, description: brief }));
    expect(same.tabs.map((t) => t.label)).toEqual(['Brief', 'As sent to agent']);
    const body = buildTicketDetails(state({ brief, description: 'Body text' }));
    expect(body.original).toBeNull();
    const differs = buildTicketDetails(state({ brief, description: 'What the user typed' }));
    expect(differs.tabs.map((t) => t.label)).toEqual(['Brief', 'Original description', 'As sent to agent']);
    expect(differs.original).toBe('What the user typed');
  });

  it('parses the brief into the main body, groups, tags and comments', () => {
    const v = buildTicketDetails(state({ brief }));
    expect(v.main).toBe('Body text');
    expect(v.groups.map((g) => g.title)).toEqual(['Details', 'People']);
    expect(v.tags).toEqual(['bug']);
    expect(v.comments).toEqual([{ author: 'Ada', text: 'hi' }]);
  });

  it('builds the Karst group from the state and only when it has rows', () => {
    const v = buildTicketDetails(
      state({
        origin: 'from D88 (P17)', subtaskParent: { key: 'K-1', ref: 'T1 · K-1', title: null }, priority: 'high',
        approach: { id: 'tdd', phases: ['red', 'green'], reported: [] },
        worktrees: [{ serviceName: 'api', repoDisplay: '/x/api' }, { serviceName: undefined, repoDisplay: 'web' }],
      }),
    );
    expect(v.groups[0]).toEqual({
      title: 'Karst',
      rows: [
        { label: 'From', value: 'from D88 (P17)' },
        { label: 'Sub-task of', value: 'T1 · K-1', ref: 'T1 · K-1' },
        { label: 'Priority', value: 'high' },
        { label: 'Approach', value: 'tdd · red · green' },
        { label: 'Repos', value: 'api, web' },
      ],
    });
    expect(buildTicketDetails(state()).groups).toEqual([]);
  });

  it('splits the planning brief and labels the source', () => {
    const v = buildTicketDetails(state({ brief: '## Planning brief\nDo it.\n\n## Design constraints\n- D400', briefSource: { kind: 'draft', draftId: 400 } }));
    expect(v.planning).toBe('Do it.\n\n## Design constraints\n- D400');
    expect(v.main).toBe('');
    expect(v.sourceLabel).toBe('from planning draft D400');
  });

  it('carries the agent text verbatim', () => {
    expect(buildTicketDetails(state({ brief })).text).toBe(brief);
  });
});
