import { describe, it, expect } from 'vitest';
import { materializeAttachments, MAX_EMBED_BYTES } from './attachments.js';

/** A fetch double: routes by URL substring to a canned Response. */
function fakeFetch(
  routes: Record<string, { status?: number; body: string | ArrayBuffer; type?: string }>,
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    calls.push({ url: u, headers: init?.headers ?? {} });
    const match = Object.entries(routes).find(([frag]) => u.includes(frag));
    if (!match) return new Response('missing', { status: 404 });
    const [, r] = match;
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: r.type ? { 'content-type': r.type } : {},
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('materializeAttachments', () => {
  it('returns an empty list untouched without fetching', async () => {
    const { fn, calls } = fakeFetch({});
    expect(await materializeAttachments([], { fetchFn: fn })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('classifies an image by content-type and records its size', async () => {
    const { fn } = fakeFetch({
      'shot.png': { body: new ArrayBuffer(1024), type: 'image/png' },
    });
    const [a] = await materializeAttachments(
      [{ name: 'shot.png', url: 'https://files/shot.png' }],
      { fetchFn: fn },
    );
    expect(a).toMatchObject({ kind: 'image', mimeType: 'image/png', size: 1024 });
    expect(a!.content).toBeUndefined();
  });

  it('inlines a text attachment', async () => {
    const { fn } = fakeFetch({
      'notes.md': { body: '# Heading\nbody', type: 'text/markdown' },
    });
    const [a] = await materializeAttachments(
      [{ name: 'notes.md', url: 'https://files/notes.md' }],
      { fetchFn: fn },
    );
    expect(a).toMatchObject({ kind: 'text', content: '# Heading\nbody', truncated: false });
  });

  it('classifies by filename extension when the server sends no content-type', async () => {
    const { fn } = fakeFetch({ 'data.json': { body: '{"a":1}' } });
    const [a] = await materializeAttachments(
      [{ name: 'data.json', url: 'https://files/data.json' }],
      { fetchFn: fn },
    );
    expect(a).toMatchObject({ kind: 'text', content: '{"a":1}' });
  });

  it('marks a binary attachment without inlining its bytes', async () => {
    const { fn } = fakeFetch({
      'app.zip': { body: new ArrayBuffer(2048), type: 'application/zip' },
    });
    const [a] = await materializeAttachments(
      [{ name: 'app.zip', url: 'https://files/app.zip' }],
      { fetchFn: fn },
    );
    expect(a).toMatchObject({ kind: 'binary', mimeType: 'application/zip', size: 2048 });
    expect(a!.content).toBeUndefined();
  });

  it('truncates text past the embed cap and flags it', async () => {
    const big = 'x'.repeat(MAX_EMBED_BYTES + 500);
    const { fn } = fakeFetch({ 'big.log': { body: big, type: 'text/plain' } });
    const [a] = await materializeAttachments(
      [{ name: 'big.log', url: 'https://files/big.log' }],
      { fetchFn: fn },
    );
    expect(a!.kind).toBe('text');
    expect(a!.truncated).toBe(true);
    expect(a!.content!.length).toBeLessThanOrEqual(MAX_EMBED_BYTES);
    expect(a!.size).toBe(big.length);
  });

  it('honours an injected cap', async () => {
    const { fn } = fakeFetch({ 'small.txt': { body: 'abcdefghij', type: 'text/plain' } });
    const [a] = await materializeAttachments(
      [{ name: 'small.txt', url: 'https://files/small.txt' }],
      { fetchFn: fn, maxBytes: 4 },
    );
    expect(a).toMatchObject({ kind: 'text', content: 'abcd', truncated: true });
  });

  it('marks a 403 as unavailable and keeps the other attachments', async () => {
    const { fn } = fakeFetch({
      'denied.png': { status: 403, body: 'nope', type: 'text/plain' },
      'ok.txt': { body: 'fine', type: 'text/plain' },
    });
    const out = await materializeAttachments(
      [
        { name: 'denied.png', url: 'https://files/denied.png' },
        { name: 'ok.txt', url: 'https://files/ok.txt' },
      ],
      { fetchFn: fn },
    );
    expect(out[0]).toMatchObject({ kind: 'unavailable' });
    expect(out[0]!.error).toContain('403');
    expect(out[1]).toMatchObject({ kind: 'text', content: 'fine' });
  });

  it('marks a network throw as unavailable rather than failing the batch', async () => {
    const fn = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const [a] = await materializeAttachments(
      [{ name: 'x.txt', url: 'https://files/x.txt' }],
      { fetchFn: fn },
    );
    expect(a).toMatchObject({ kind: 'unavailable' });
    expect(a!.error).toContain('socket hang up');
  });

  it('sends an auth header only where authFor supplies one', async () => {
    const { fn, calls } = fakeFetch({
      'inside.txt': { body: 'a', type: 'text/plain' },
      'outside.txt': { body: 'b', type: 'text/plain' },
    });
    await materializeAttachments(
      [
        { name: 'inside.txt', url: 'https://api.clickup.com/inside.txt' },
        { name: 'outside.txt', url: 'https://s3.example/outside.txt' },
      ],
      {
        fetchFn: fn,
        authFor: async (url) => (url.includes('clickup.com') ? 'tok' : undefined),
      },
    );
    expect(calls[0]!.headers.Authorization).toBe('tok');
    expect(calls[1]!.headers.Authorization).toBeUndefined();
  });

  it('does not mutate the input attachments', async () => {
    const { fn } = fakeFetch({ 'a.txt': { body: 'hi', type: 'text/plain' } });
    const input = [{ name: 'a.txt', url: 'https://files/a.txt' }];
    const frozen = Object.freeze({ ...input[0]! });
    await materializeAttachments([frozen], { fetchFn: fn });
    expect(frozen).toEqual({ name: 'a.txt', url: 'https://files/a.txt' });
  });
});
