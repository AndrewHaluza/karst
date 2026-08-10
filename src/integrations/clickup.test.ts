import { describe, it, expect, vi } from 'vitest';
import { clickupProvider, ClickupError } from './clickup.js';

/** A minimal fetch double: routes by URL substring to a canned Response. */
function fakeFetch(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: {
    url: string;
    headers: Record<string, string>;
    method?: string;
    body?: string;
  }[] = [];
  const fn = (async (
    url: string | URL,
    init?: { headers?: Record<string, string>; method?: string; body?: string },
  ) => {
    const u = String(url);
    calls.push({
      url: u,
      headers: init?.headers ?? {},
      method: init?.method,
      body: init?.body,
    });
    const match = Object.entries(routes).find(([frag]) => u.includes(frag));
    if (!match) return new Response('not found', { status: 404 });
    const [, r] = match;
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const TASK = {
  id: 'abc123',
  name: 'Fix the login modal',
  text_content: 'Users cannot close the modal. Must add an X button.',
  tags: [{ name: 'frontend' }, { name: 'bug' }],
  url: 'https://app.clickup.com/t/abc123',
  attachments: [
    { title: 'screenshot.png', url: 'https://files/screenshot.png', mimetype: 'image/png' },
  ],
};

const COMMENTS = {
  comments: [
    { comment_text: 'Repro on Safari only', user: { username: 'qa_jane' }, date: '1700000000000' },
    { comment_text: 'Design attached', user: { username: 'pm_bob' }, date: '1700000100000' },
  ],
};

describe('clickupProvider.fetchTicket', () => {
  it('parses task + comments + attachments into a ContextBrief', async () => {
    const { fn } = fakeFetch({
      '/task/abc123/comment': { json: COMMENTS },
      '/task/abc123': { json: TASK },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    const brief = await provider.fetchTicket!('abc123');

    expect(brief.title).toBe('Fix the login modal');
    expect(brief.description).toContain('X button');
    expect(brief.tags).toEqual(['frontend', 'bug']);
    expect(brief.attachments).toHaveLength(1);
    expect(brief.attachments[0]).toMatchObject({
      name: 'screenshot.png',
      url: 'https://files/screenshot.png',
      // The download 404s under this fixture's routes — recorded on the
      // attachment, never propagated as a failed ticket fetch.
      kind: 'unavailable',
    });
    expect(brief.comments).toHaveLength(2);
    expect(brief.comments[0]).toMatchObject({ author: 'qa_jane', text: 'Repro on Safari only' });
  });

  it('sends the token in the Authorization header on every API request', async () => {
    const { fn, calls } = fakeFetch({
      '/task/abc123/comment': { json: COMMENTS },
      '/task/abc123': { json: TASK },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'secret-token' });
    await provider.fetchTicket!('abc123');

    const api = calls.filter((c) => c.url.includes('api.clickup.com'));
    expect(api.length).toBeGreaterThanOrEqual(2);
    for (const c of api) {
      expect(c.headers.Authorization).toBe('secret-token');
    }
  });

  it('never sends the token to an attachment host outside clickup.com', async () => {
    const { fn, calls } = fakeFetch({
      '/task/abc123/comment': { json: COMMENTS },
      '/task/abc123': { json: TASK },
      'screenshot.png': { json: {} },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'secret-token' });
    await provider.fetchTicket!('abc123');

    const download = calls.find((c) => c.url === 'https://files/screenshot.png');
    expect(download).toBeDefined();
    expect(download!.headers.Authorization).toBeUndefined();
  });

  it('sends the token when the attachment lives on a clickup.com host', async () => {
    const { fn, calls } = fakeFetch({
      '/task/z/comment': { json: {} },
      '/task/z': {
        json: {
          id: 'z',
          name: 't',
          attachments: [
            { title: 'a.png', url: 'https://attachments.clickup.com/a.png', mimetype: 'image/png' },
          ],
        },
      },
      'attachments.clickup.com': { json: {} },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'secret-token' });
    await provider.fetchTicket!('z');

    const download = calls.find((c) => c.url.includes('attachments.clickup.com'));
    expect(download!.headers.Authorization).toBe('secret-token');
  });

  it('appends the team_id/custom_task_ids suffix on task and comment URLs when teamId is set', async () => {
    const { fn, calls } = fakeFetch({
      '/task/abc123/comment': { json: COMMENTS },
      '/task/abc123': { json: TASK },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', teamId: '9001' });
    await provider.fetchTicket!('abc123');

    // Only the API calls carry the suffix — an attachment download goes to the
    // URL the payload gave, verbatim.
    const api = calls.filter((c) => c.url.includes('api.clickup.com'));
    expect(api.length).toBeGreaterThanOrEqual(2);
    for (const c of api) {
      expect(c.url).toContain('custom_task_ids=true');
      expect(c.url).toContain('team_id=9001');
    }
  });

  it('throws a typed ClickupError on a non-2xx task response', async () => {
    const { fn } = fakeFetch({
      '/task/abc123/comment': { json: COMMENTS },
      '/task/abc123': { status: 401, json: { err: 'Unauthorized' } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'bad' });

    await expect(provider.fetchTicket!('abc123')).rejects.toBeInstanceOf(ClickupError);
    await expect(provider.fetchTicket!('abc123')).rejects.toThrow(/401/);
  });

  it('throws ClickupError when the network call rejects', async () => {
    const fn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.fetchTicket!('abc123')).rejects.toBeInstanceOf(ClickupError);
  });

  it('falls back to `description` when `text_content` is an empty string', async () => {
    const { fn } = fakeFetch({
      '/task/y/comment': { json: {} },
      '/task/y': { json: { id: 'y', name: 'has md only', text_content: '', description: 'real markdown body' } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    const brief = await provider.fetchTicket!('y');
    expect(brief.description).toBe('real markdown body');
  });

  it('tolerates missing optional fields (no comments, no attachments)', async () => {
    const { fn } = fakeFetch({
      '/task/x/comment': { json: {} },
      '/task/x': { json: { id: 'x', name: 'bare' } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    const brief = await provider.fetchTicket!('x');
    expect(brief.title).toBe('bare');
    expect(brief.description).toBe('');
    expect(brief.comments).toEqual([]);
    expect(brief.attachments).toEqual([]);
    expect(brief.tags).toEqual([]);
  });
});

describe('clickupProvider.fetchTicket enrichment', () => {
  const RICH = {
    id: 'T-100',
    name: 'Rich task',
    text_content: 'Blocked work. Spec at https://docs.example/spec.',
    url: 'https://app.clickup.com/t/T-100',
    status: { status: 'in review' },
    priority: { priority: 'urgent' },
    date_created: '1700000000000',
    date_updated: '1700000500000',
    due_date: '1700900000000',
    start_date: null,
    date_closed: null,
    list: { name: 'Sprint 12' },
    assignees: [{ username: 'jane', email: 'jane@x.io' }, { email: 'noname@x.io' }],
    creator: { username: 'bob' },
    watchers: [{ username: 'kim' }],
    parent: 'EPIC-9',
    linked_tasks: [{ task_id: 'REL-1' }, { task_id: 'T-100' }],
    dependencies: [
      { task_id: 'T-100', depends_on: 'DEP-1', type: 1 },
      { task_id: 'DOWN-1', depends_on: 'T-100', type: 0 },
    ],
  };

  it('parses status, priority, url, milestone, people, relations, timestamps, links', async () => {
    const { fn } = fakeFetch({
      '/task/T-100/comment': { json: {} },
      '/task/T-100': { json: RICH },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    const brief = await provider.fetchTicket!('T-100');

    expect(brief.status).toBe('in review');
    expect(brief.priority).toBe('urgent');
    expect(brief.url).toBe('https://app.clickup.com/t/T-100');
    expect(brief.milestone).toBe('Sprint 12');

    // People: named assignee + email-only assignee, reporter (creator), watcher.
    expect(brief.people).toEqual([
      { name: 'jane', role: 'assignee', email: 'jane@x.io' },
      { name: 'noname@x.io', role: 'assignee', email: 'noname@x.io' },
      { name: 'bob', role: 'reporter' },
      { name: 'kim', role: 'watcher' },
    ]);

    // Relations: parent, related (self-link to T-100 dropped), and dependency
    // direction derived from which id is this task.
    expect(brief.relations).toEqual([
      { kind: 'parent', ref: 'EPIC-9' },
      { kind: 'related', ref: 'REL-1' },
      { kind: 'blocked-by', ref: 'DEP-1' },
      { kind: 'blocks', ref: 'DOWN-1' },
    ]);

    expect(brief.timestamps?.created).toBe(new Date(1700000000000).toISOString());
    expect(brief.timestamps?.updated).toBe(new Date(1700000500000).toISOString());
    expect(brief.timestamps?.due).toBe(new Date(1700900000000).toISOString());
    // null/absent times are omitted, not surfaced as epoch zero.
    expect(brief.timestamps?.start).toBeUndefined();
    expect(brief.timestamps?.closed).toBeUndefined();

    expect(brief.links).toEqual(['https://docs.example/spec']);
  });

  it('omits every enrichment field on a bare task (backward-compatible shape)', async () => {
    const { fn } = fakeFetch({
      '/task/x/comment': { json: {} },
      '/task/x': { json: { id: 'x', name: 'bare' } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    const brief = await provider.fetchTicket!('x');
    expect(brief.status).toBeUndefined();
    expect(brief.priority).toBeUndefined();
    expect(brief.url).toBeUndefined();
    expect(brief.milestone).toBeUndefined();
    expect(brief.people).toBeUndefined();
    expect(brief.relations).toBeUndefined();
    expect(brief.timestamps).toBeUndefined();
    expect(brief.links).toBeUndefined();
  });

  it('requests subtasks and includes only immediate children as rich child relations', async () => {
    const { fn, calls } = fakeFetch({
      '/task/T-100/comment': { json: {} },
      '/task/T-100': {
        json: {
          id: 'T-100',
          name: 'Parent',
          subtasks: [
            { id: 'C-1', parent: 'T-100', name: 'Immediate', status: { status: 'to do' } },
            { id: 'GC-1', parent: 'C-1', name: 'Nested', status: { status: 'open' } },
            { parent: 'T-100', name: 'Missing id' },
          ],
        },
      },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    const brief = await provider.fetchTicket!('T-100');

    expect(calls.find((c) => c.url.includes('/task/T-100?'))?.url)
      .toContain('include_subtasks=true');
    expect(brief.relations).toEqual([
      { kind: 'child', ref: 'C-1', title: 'Immediate', status: 'to do' },
    ]);
  });

  it('composes include_subtasks with custom task id parameters', async () => {
    const { fn, calls } = fakeFetch({
      '/task/T-100/comment': { json: {} },
      '/task/T-100': { json: { id: 'T-100', name: 'Parent' } },
    });
    const provider = clickupProvider({
      fetchFn: fn,
      token: async () => 'tok',
      teamId: '9001',
    });

    await provider.fetchTicket!('T-100');

    const taskCall = calls.find((c) =>
      c.url.includes('/task/T-100?') && !c.url.includes('/comment'),
    );
    expect(taskCall?.url).toContain('include_subtasks=true');
    expect(taskCall?.url).toContain('custom_task_ids=true');
    expect(taskCall?.url).toContain('team_id=9001');
  });

  it('uses a canonical relation id without custom-id parameters after fetching a custom primary ref', async () => {
    const { fn, calls } = fakeFetch({
      '/task/CUSTOM-100/comment': { json: {} },
      '/task/CUSTOM-100?': {
        json: {
          id: 'CANON-100',
          name: 'Parent',
          linked_tasks: [{ task_id: 'CANON-REL' }],
        },
      },
      '/task/CANON-REL': {
        json: { id: 'CANON-REL', name: 'Canonical relation', status: { status: 'open' } },
      },
    });
    const provider = clickupProvider({
      fetchFn: fn,
      token: async () => 'tok',
      teamId: '9001',
    });

    const brief = await provider.fetchTicket!('CUSTOM-100');

    expect(calls.find((c) => c.url.includes('/task/CUSTOM-100?'))?.url)
      .toContain('custom_task_ids=true&team_id=9001');
    expect(calls.find((c) => c.url.includes('/task/CUSTOM-100/comment?'))?.url)
      .toContain('custom_task_ids=true&team_id=9001');
    expect(calls.find((c) => c.url.includes('/task/CANON-REL'))?.url)
      .toBe('https://api.clickup.com/api/v2/task/CANON-REL');
    expect(brief.relations).toEqual([
      { kind: 'related', ref: 'CANON-REL', title: 'Canonical relation', status: 'open' },
    ]);
  });

  it('enriches unresolved task relations with title and status', async () => {
    const { fn } = fakeFetch({
      '/task/REL-1': {
        json: { id: 'REL-1', name: 'Related work', status: { status: 'in progress' } },
      },
      '/task/T-100/comment': { json: {} },
      '/task/T-100?': {
        json: {
          id: 'T-100',
          name: 'Parent',
          linked_tasks: [{ task_id: 'REL-1' }],
        },
      },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    const brief = await provider.fetchTicket!('T-100');

    expect(brief.relations).toEqual([
      {
        kind: 'related',
        ref: 'REL-1',
        title: 'Related work',
        status: 'in progress',
      },
    ]);
  });

  it('fetches a repeated unresolved relation ref only once', async () => {
    const { fn, calls } = fakeFetch({
      '/task/REL-1': { json: { id: 'REL-1', name: 'Shared relation' } },
      '/task/T-100/comment': { json: {} },
      '/task/T-100?': {
        json: {
          id: 'T-100',
          name: 'Parent',
          linked_tasks: [{ task_id: 'REL-1' }],
          dependencies: [{ task_id: 'T-100', depends_on: 'REL-1' }],
        },
      },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await provider.fetchTicket!('T-100');

    expect(calls.filter((c) => c.url.endsWith('/task/REL-1'))).toHaveLength(1);
  });

  it('keeps a bare relation when metadata fetch fails', async () => {
    const { fn } = fakeFetch({
      '/task/REL-1': { status: 403, json: {} },
      '/task/T-100/comment': { json: {} },
      '/task/T-100?': {
        json: {
          id: 'T-100',
          name: 'Parent',
          linked_tasks: [{ task_id: 'REL-1' }],
        },
      },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.fetchTicket!('T-100')).resolves.toMatchObject({
      relations: [{ kind: 'related', ref: 'REL-1' }],
    });
  });

  it('keeps a bare relation when metadata fetch times out', async () => {
    vi.useFakeTimers();
    try {
      let metadataSignal: AbortSignal | undefined;
      let signalMetadataStarted!: () => void;
      const metadataStarted = new Promise<void>((resolve) => {
        signalMetadataStarted = resolve;
      });
      const fn = (async (url: string | URL, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.includes('/task/REL-1')) {
          metadataSignal = init?.signal ?? undefined;
          signalMetadataStarted();
          return new Promise<Response>((_resolve, reject) => {
            metadataSignal?.addEventListener('abort', () => {
              reject(new DOMException('metadata request timed out', 'AbortError'));
            }, { once: true });
          });
        }
        if (requestUrl.includes('/comment')) return new Response(JSON.stringify({}));
        return new Response(JSON.stringify({
          id: 'T-100',
          name: 'Parent',
          linked_tasks: [{ task_id: 'REL-1' }],
        }));
      }) as typeof fetch;
      const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

      const briefPromise = provider.fetchTicket!('T-100');
      await metadataStarted;
      expect(metadataSignal).toBeDefined();

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(briefPromise).resolves.toMatchObject({
        relations: [{ kind: 'related', ref: 'REL-1' }],
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a bare relation when successful metadata is malformed', async () => {
    const { fn } = fakeFetch({
      '/task/REL-1': { json: { id: 'REL-1', name: { malformed: true }, status: { status: 42 } } },
      '/task/T-100/comment': { json: {} },
      '/task/T-100?': {
        json: {
          id: 'T-100',
          name: 'Parent',
          linked_tasks: [{ task_id: 'REL-1' }],
        },
      },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.fetchTicket!('T-100')).resolves.toMatchObject({
      relations: [{ kind: 'related', ref: 'REL-1' }],
    });
  });

  it('keeps a bare relation when successful metadata is null', async () => {
    const { fn } = fakeFetch({
      '/task/REL-1': { json: null },
      '/task/T-100/comment': { json: {} },
      '/task/T-100?': {
        json: {
          id: 'T-100',
          name: 'Parent',
          linked_tasks: [{ task_id: 'REL-1' }],
        },
      },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.fetchTicket!('T-100')).resolves.toMatchObject({
      relations: [{ kind: 'related', ref: 'REL-1' }],
    });
  });
});

const LIST = {
  id: '42',
  name: 'Sprint',
  statuses: [
    { id: 's1', status: 'to do', orderindex: 0, color: '#aaa', type: 'open' },
    { id: 's2', status: 'in review', orderindex: 1, color: '#bbb', type: 'custom' },
    { id: 's3', status: 'done', orderindex: 2, color: '#ccc', type: 'done' },
  ],
};

describe('clickupProvider.listStatuses', () => {
  it('maps the list statuses to names in provider order', async () => {
    const { fn } = fakeFetch({ '/list/42': { json: LIST } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    expect(await provider.listStatuses!()).toEqual(['to do', 'in review', 'done']);
  });

  it('returns [] when the list has no statuses of its own (inherited from its Space)', async () => {
    const { fn } = fakeFetch({ '/list/42': { json: { id: '42', name: 'Sprint' } } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    expect(await provider.listStatuses!()).toEqual([]);
  });

  it('drops entries whose status is not a string', async () => {
    const { fn } = fakeFetch({
      '/list/42': { json: { statuses: [{ status: 'open' }, { status: 42 }, {}] } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    expect(await provider.listStatuses!()).toEqual(['open']);
  });

  it('throws a ClickupError when no listId is configured', async () => {
    const { fn } = fakeFetch({});
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.listStatuses!()).rejects.toThrow(ClickupError);
  });

  it('throws a ClickupError on a non-ok response', async () => {
    const { fn } = fakeFetch({ '/list/42': { status: 401, json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    await expect(provider.listStatuses!()).rejects.toThrow(/401/);
  });
});

describe('clickupProvider.listLists', () => {
  it('merges folderless + folder lists across spaces, tagged by space name', async () => {
    const { fn } = fakeFetch({
      '/team/9001/space': { json: { spaces: [{ id: 's1', name: 'Eng' }, { id: 's2', name: 'Design' }] } },
      '/space/s1/list': { json: { lists: [{ id: '101', name: 'Backlog' }] } },
      '/space/s1/folder': { json: { folders: [{ lists: [{ id: '102', name: 'Sprint' }] }] } },
      '/space/s2/list': { json: { lists: [{ id: '201', name: 'Icons' }] } },
      '/space/s2/folder': { json: { folders: [] } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', teamId: '9001' });

    expect(await provider.listLists!()).toEqual([
      { id: '101', name: 'Backlog', space: 'Eng' },
      { id: '102', name: 'Sprint', space: 'Eng' },
      { id: '201', name: 'Icons', space: 'Design' },
    ]);
  });

  it('returns [] for a workspace with no spaces', async () => {
    const { fn } = fakeFetch({ '/team/9001/space': { json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', teamId: '9001' });
    expect(await provider.listLists!()).toEqual([]);
  });

  it('drops malformed list entries (missing id or name)', async () => {
    const { fn } = fakeFetch({
      '/team/9001/space': { json: { spaces: [{ id: 's1', name: 'Eng' }] } },
      '/space/s1/list': { json: { lists: [{ id: '101', name: 'Ok' }, { id: '102' }, { name: 'NoId' }] } },
      '/space/s1/folder': { json: { folders: [] } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', teamId: '9001' });
    expect(await provider.listLists!()).toEqual([{ id: '101', name: 'Ok', space: 'Eng' }]);
  });

  it('throws a ClickupError when no teamId is configured', async () => {
    const { fn } = fakeFetch({});
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });
    await expect(provider.listLists!()).rejects.toThrow(ClickupError);
  });

  it('throws a ClickupError on a non-ok response', async () => {
    const { fn } = fakeFetch({ '/team/9001/space': { status: 500, json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', teamId: '9001' });
    await expect(provider.listLists!()).rejects.toThrow(/500/);
  });
});

describe('clickupProvider.updateStatus', () => {
  it('PUTs the status name to the task', async () => {
    const { fn, calls } = fakeFetch({ '/task/abc123': { json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await provider.updateStatus('abc123', 'in review');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toContain('/task/abc123');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: 'in review' });
    expect(calls[0]!.headers.Authorization).toBe('tok');
  });

  it('carries the custom-task-id suffix when a teamId is configured', async () => {
    const { fn, calls } = fakeFetch({ '/task/abc123': { json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', teamId: '9001' });

    await provider.updateStatus('abc123', 'done');

    expect(calls[0]!.url).toContain('custom_task_ids=true&team_id=9001');
  });

  it('throws a ClickupError when the provider rejects the status', async () => {
    const { fn } = fakeFetch({ '/task/abc123': { status: 400, json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.updateStatus('abc123', 'nope')).rejects.toThrow(ClickupError);
  });
});

describe('clickupProvider.searchTickets', () => {
  const LIST_TASKS = [
    {
      id: 't-low',
      name: 'Low priority ticket',
      status: { status: 'to do' },
      priority: { priority: 'low', orderindex: '4' },
    },
    {
      id: 't-high',
      name: 'High priority ticket',
      status: { status: 'to do' },
      priority: { priority: 'high', orderindex: '2' },
    },
    {
      id: 't-none',
      name: 'No priority ticket',
      status: { status: 'in review' },
      priority: null,
    },
    {
      id: 't-urgent',
      name: 'Urgent ticket',
      status: { status: 'to do' },
      priority: { priority: 'urgent', orderindex: '1' },
    },
    {
      id: 't-other',
      name: 'Unrelated widget',
      status: { status: 'to do' },
      priority: { priority: 'normal', orderindex: '3' },
    },
  ];

  /**
   * A fetch that EMULATES the real endpoint: honors the `statuses[]` filter and
   * `page` slicing server-side (like ClickUp does) — the provider only matches
   * the title client-side, so a fixture that returned every task regardless of
   * the status parameter would make the status-filter tests meaningless.
   */
  function listFetch(pageSize = 100) {
    const calls: { url: string }[] = [];
    const fn = (async (url: string | URL) => {
      const u = String(url);
      calls.push({ url: u });
      const parsed = new URL(u);
      const page = Number(parsed.searchParams.get('page') ?? 0);
      const statuses = parsed.searchParams.getAll('statuses[]');
      const matching = LIST_TASKS.filter(
        (t) => statuses.length === 0 || statuses.includes(t.status.status),
      );
      const tasks = matching.slice(page * pageSize, (page + 1) * pageSize);
      return new Response(
        JSON.stringify({
          tasks,
          last_page: (page + 1) * pageSize >= matching.length,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('searches the configured list by title and returns ref/title/status/priority', async () => {
    const { fn, calls } = listFetch();
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    const results = await provider.searchTickets!('ticket', { status: 'to do' });

    expect(results.map((r) => r.ref)).toEqual(['t-urgent', 't-high', 't-low']);
    expect(results[0]).toEqual({
      ref: 't-urgent',
      title: 'Urgent ticket',
      status: 'to do',
      priority: 'urgent',
    });
    // The list endpoint, with the status filter and no closed/subtasks.
    expect(calls[0]!.url).toContain('/list/42/task?');
    expect(calls[0]!.url).toContain('statuses%5B%5D=to+do');
    expect(calls[0]!.url).toContain('include_closed=false');
    expect(calls[0]!.url).toContain('subtasks=false');
    expect(calls[0]!.url).toContain('page=0');
  });

  it('sorts by priority with highest first, unknown priority last', async () => {
    const { fn } = listFetch();
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    const results = await provider.searchTickets!('priority');

    // 'Low priority ticket' (low) and 'High priority ticket' (high) match;
    // 'No priority ticket' carries no priority object at all.
    expect(results.map((r) => r.ref)).toEqual(['t-high', 't-low', 't-none']);
  });

  it('filters case-insensitively and never matches an empty query', async () => {
    const { fn, calls } = listFetch();
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    // 'TICKET' matches every task whose name ends in "ticket" (4 of 5).
    expect(await provider.searchTickets!('TICKET')).toHaveLength(4);
    expect(await provider.searchTickets!('')).toEqual([]);
    expect(await provider.searchTickets!('   ')).toEqual([]);
    // An empty query never hits the API.
    expect(calls).toHaveLength(1);
  });

  it('drops the status filter when no status is requested', async () => {
    const { fn, calls } = listFetch();
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    await provider.searchTickets!('ticket');

    expect(calls[0]!.url).not.toContain('statuses');
    expect(await provider.searchTickets!('ticket')).toHaveLength(4);
  });

  it('pages through results until last_page or enough matches', async () => {
    const { fn, calls } = listFetch(2);
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    const results = await provider.searchTickets!('ticket');

    expect(results.map((r) => r.ref)).toEqual(['t-urgent', 't-high', 't-low', 't-none']);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[1]!.url).toContain('page=1');
  });

  it('throws a ClickupError when no listId is configured', async () => {
    const { fn } = listFetch();
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.searchTickets!('x', { status: 'to do' })).rejects.toThrow(/List ID/);
  });

  it('throws a ClickupError on a non-ok response', async () => {
    const { fn } = fakeFetch({ '/list/42/task': { status: 500, json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    await expect(provider.searchTickets!('x')).rejects.toThrow(/500/);
  });
});

describe('clickupProvider.createTicket', () => {
  it('POSTs title + description to the configured list and returns ref/url', async () => {
    const { fn, calls } = fakeFetch({
      '/list/42/task': {
        json: {
          id: 'cu-new-1',
          name: 'Fix login',
          url: 'https://app.clickup.com/t/cu-new-1',
        },
      },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    const created = await provider.createTicket!({
      title: 'Fix login',
      description: 'The modal cannot close.',
    });

    expect(created).toEqual({ ref: 'cu-new-1', url: 'https://app.clickup.com/t/cu-new-1' });
    const call = calls.find((c) => c.url.includes('/list/42/task'));
    expect(call).toBeDefined();
    expect(call!.method).toBe('POST');
    expect(call!.headers.Authorization).toBe('tok');
    expect(call!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call!.body ?? '{}')).toEqual({
      name: 'Fix login',
      description: 'The modal cannot close.',
    });
  });

  it('omits description when none is given', async () => {
    const { fn, calls } = fakeFetch({
      '/list/42/task': { json: { id: 'cu-new-2', name: 't' } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    await provider.createTicket!({ title: 't' });

    const call = calls.find((c) => c.url.includes('/list/42/task'));
    expect(JSON.parse(call!.body ?? '{}')).toEqual({ name: 't' });
  });

  it('returns a bare ref when the payload carries no url', async () => {
    const { fn } = fakeFetch({ '/list/42/task': { json: { id: 'cu-new-3', name: 't' } } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    expect(await provider.createTicket!({ title: 't' })).toEqual({ ref: 'cu-new-3' });
  });

  it('throws a ClickupError when no listId is configured', async () => {
    const { fn } = fakeFetch({ '/list/42/task': { json: { id: 'x' } } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.createTicket!({ title: 't' })).rejects.toThrow(/List ID/);
  });

  it('throws a ClickupError on a network failure', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    await expect(provider.createTicket!({ title: 't' })).rejects.toThrow(
      /ClickUp: request failed: fetch failed/,
    );
  });

  it('throws a ClickupError on a non-ok response', async () => {
    const { fn } = fakeFetch({ '/list/42/task': { status: 403, json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    await expect(provider.createTicket!({ title: 't' })).rejects.toThrow(/403/);
  });

  it('throws a ClickupError when the response has no task id', async () => {
    const { fn } = fakeFetch({ '/list/42/task': { json: { name: 't' } } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    await expect(provider.createTicket!({ title: 't' })).rejects.toThrow(/no id/i);
  });
});
