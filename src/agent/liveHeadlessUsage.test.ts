import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTranscriptReader } from './claudeTranscriptRead.js';
import { parseClaudeTranscript } from './claudeTranscriptWatch.js';
import { LiveHeadlessUsage, sweepLiveHeadless } from './liveHeadlessUsage.js';

/** One transcript line of an assistant API message; blocks of one message repeat its usage. */
function line(uuid: string, messageId: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', uuid, message: { id: messageId, usage } }) + '\n';
}
const U = (input: number, output: number, cacheRead: number, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

describe('parseClaudeTranscript dedupeMessages', () => {
  const text =
    line('u1', 'm1', U(2, 162, 9102)) + line('u2', 'm1', U(2, 162, 9102)) + line('u3', 'm2', U(2, 89, 36948));
  it('counts a message once, however many blocks it wrote (matches the call envelope)', () => {
    expect(parseClaudeTranscript(text, { dedupeMessages: true })).toMatchObject({
      input: 4,
      output: 251,
      cacheRead: 46050,
      eventId: 'u3',
    });
  });
  it('keeps the interactive line sum when not asked (its ledger is calibrated on it)', () => {
    expect(parseClaudeTranscript(text)).toMatchObject({ output: 413 });
  });
  it('the last line of a message wins', () => {
    const t = line('u1', 'm1', U(2, 1, 0)) + line('u2', 'm1', U(2, 90, 0));
    expect(parseClaudeTranscript(t, { dedupeMessages: true })).toMatchObject({ output: 90 });
  });
});

describe('LiveHeadlessUsage + sweep with a growing transcript', () => {
  let dir: string;
  let path: string;
  const debug = vi.fn();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-live-'));
    path = join(dir, 's1.jsonl');
    debug.mockReset();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const deps = () => {
    const r = makeTranscriptReader();
    return { stat: r.stat, readFile: r.readFile, debug };
  };

  it('follows the transcript as it grows, and reports a change only when the count moved', async () => {
    const live = new LiveHeadlessUsage();
    live.register(7, 42, { sessionId: 's1', transcriptPath: path });
    // No transcript yet: no reading, a debug line, no throw.
    expect(await sweepLiveHeadless(live, deps())).toEqual([]);
    expect(live.read([7])).toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('transcript not readable'));

    writeFileSync(path, line('u1', 'm1', U(2, 100, 9000)));
    expect(await sweepLiveHeadless(live, deps())).toEqual([42]);
    expect(live.read([7])).toEqual({ total: 9102, cacheRead: 9000 });

    // Unchanged file: not read again, nothing changed.
    expect(await sweepLiveHeadless(live, deps())).toEqual([]);

    appendFileSync(path, line('u2', 'm2', U(2, 50, 9100, 10)));
    expect(await sweepLiveHeadless(live, deps())).toEqual([42]);
    expect(live.read([7])).toEqual({ total: 9102 + 9162, cacheRead: 18100 });
  });

  it('sums the calls of one run and ignores other runs', async () => {
    const live = new LiveHeadlessUsage();
    const second = join(dir, 's2.jsonl');
    live.register(7, 42, { sessionId: 's1', transcriptPath: path });
    live.register(7, 42, { sessionId: 's2', transcriptPath: second });
    live.register(8, 43, { sessionId: 's3', transcriptPath: join(dir, 's3.jsonl') });
    writeFileSync(path, line('u1', 'm1', U(1, 1, 0)));
    writeFileSync(second, line('u2', 'm2', U(2, 2, 0)));
    writeFileSync(join(dir, 's3.jsonl'), line('u3', 'm3', U(99, 99, 0)));
    await sweepLiveHeadless(live, deps());
    expect(live.read([7])).toEqual({ total: 6, cacheRead: 0 });
    expect(live.read([9])).toBeNull();
  });

  it('an unreadable transcript clears the reading, logs, and never throws', async () => {
    const live = new LiveHeadlessUsage();
    live.register(7, 42, { sessionId: 's1', transcriptPath: path });
    writeFileSync(path, line('u1', 'm1', U(1, 1, 0)));
    await sweepLiveHeadless(live, deps());
    expect(live.read([7])).not.toBeNull();
    const failing = { ...deps(), readFile: async () => { throw new Error('EIO'); } };
    appendFileSync(path, line('u2', 'm2', U(1, 1, 0))); // fingerprint moves, so the read runs
    expect(await sweepLiveHeadless(live, failing)).toEqual([42]);
    expect(live.read([7])).toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('transcript read failed'));
  });

  it('a transcript with no usage yet is no reading (placeholder stays)', async () => {
    const live = new LiveHeadlessUsage();
    live.register(7, 42, { sessionId: 's1', transcriptPath: path });
    writeFileSync(path, JSON.stringify({ type: 'user', uuid: 'x' }) + '\n');
    await sweepLiveHeadless(live, deps());
    expect(live.read([7])).toBeNull();
  });

  it('the release drops the reading and is idempotent; a stale release leaves a newer call alone', async () => {
    const live = new LiveHeadlessUsage();
    const release = live.register(7, 42, { sessionId: 's1', transcriptPath: path });
    writeFileSync(path, line('u1', 'm1', U(1, 1, 0)));
    await sweepLiveHeadless(live, deps());
    release();
    release();
    expect(live.read([7])).toBeNull();
    expect(live.targets()).toEqual([]);
    const again = live.register(7, 42, { sessionId: 's1', transcriptPath: path });
    release(); // the old release must not remove the new entry
    expect(live.targets()).toHaveLength(1);
    again();
  });

  it('writes a steady fault once, not on every tick; a recovery re-arms it', async () => {
    const live = new LiveHeadlessUsage();
    live.register(8, 1, { sessionId: 's2', transcriptPath: path });
    await sweepLiveHeadless(live, deps());
    await sweepLiveHeadless(live, deps());
    await sweepLiveHeadless(live, deps());
    expect(debug).toHaveBeenCalledTimes(1);
    writeFileSync(path, line('u1', 'm1', U(1, 2, 3)));
    await sweepLiveHeadless(live, deps());
    rmSync(path);
    await sweepLiveHeadless(live, deps());
    expect(debug).toHaveBeenCalledTimes(2);
  });
});
