import { describe, it, expect } from 'vitest';
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
    expect(brief.attachments).toEqual([
      { name: 'screenshot.png', url: 'https://files/screenshot.png' },
    ]);
    expect(brief.comments).toHaveLength(2);
    expect(brief.comments[0]).toMatchObject({ author: 'qa_jane', text: 'Repro on Safari only' });
  });

  it('sends the token in the Authorization header on every request', async () => {
    const { fn, calls } = fakeFetch({
      '/task/abc123/comment': { json: COMMENTS },
      '/task/abc123': { json: TASK },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'secret-token' });
    await provider.fetchTicket!('abc123');

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.headers.Authorization).toBe('secret-token');
    }
  });

  it('appends the team_id/custom_task_ids suffix on task and comment URLs when teamId is set', async () => {
    const { fn, calls } = fakeFetch({
      '/task/abc123/comment': { json: COMMENTS },
      '/task/abc123': { json: TASK },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', teamId: '9001' });
    await provider.fetchTicket!('abc123');

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
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
