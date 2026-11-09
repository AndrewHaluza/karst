import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveHeadlessBinding } from './liveHeadlessBinding.js';

const line = (id: string, out: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: 'u-' + id,
    message: { id, usage: { input_tokens: 5, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
  }) + '\n';

describe('createLiveHeadlessBinding (@arch:AC-14)', () => {
  it('ignores a call with no process run', () => {
    const b = createLiveHeadlessBinding({ debug: vi.fn(), onChanged: vi.fn() });
    expect(b.onLiveSession({ sessionId: 's', transcriptPath: '/x' }, { ticketId: 1 })).toBeUndefined();
    expect(b.onLiveSession({ sessionId: 's', transcriptPath: '/x' })).toBeUndefined();
  });

  it('reads a growing transcript on tick, notifies the ticket, and drops the reading on release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-live-'));
    const transcriptPath = join(dir, 's.jsonl');
    writeFileSync(transcriptPath, line('m1', 10));
    const onChanged = vi.fn();
    const b = createLiveHeadlessBinding({ debug: vi.fn(), onChanged });
    const release = b.onLiveSession({ sessionId: 's', transcriptPath }, { processRunId: 7, ticketId: 3 });
    expect(release).toBeTypeOf('function');

    await b.tick();
    expect(b.read([7])).toEqual({ total: 115, cacheRead: 100 });
    expect(onChanged).toHaveBeenCalledWith(3);

    appendFileSync(transcriptPath, line('m2', 20));
    await b.tick();
    expect(b.read([7])).toEqual({ total: 240, cacheRead: 200 });

    release?.();
    expect(b.read([7])).toBeNull();
  });

  it('keeps the placeholder (null) and writes a debug line for a missing transcript', async () => {
    const debug = vi.fn();
    const b = createLiveHeadlessBinding({ debug, onChanged: vi.fn() });
    b.onLiveSession({ sessionId: 's', transcriptPath: join(tmpdir(), 'karst-none', 'x.jsonl') }, { processRunId: 1, ticketId: 1 });
    await expect(b.tick()).resolves.toBeUndefined();
    expect(b.read([1])).toBeNull();
    expect(debug).toHaveBeenCalled();
  });
});
