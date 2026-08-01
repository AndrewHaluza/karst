import { describe, it, expect, vi } from 'vitest';
import {
  readRequestId,
  reportAction,
  MAX_RESULT_MESSAGE_CHARS,
  type ActionResultMessage,
} from './actionResult.js';

const collect = (): { post: (m: ActionResultMessage) => void; sent: ActionResultMessage[] } => {
  const sent: ActionResultMessage[] = [];
  return { post: (m) => sent.push(m), sent };
};

describe('readRequestId', () => {
  it('reads a well-formed id off the raw message', () => {
    expect(readRequestId({ type: 'archive', requestId: 'k7-7' })).toBe('k7-7');
  });

  it('ignores anything that is not a plain short string', () => {
    // The webview is a trust boundary: the id is echoed back verbatim, so an
    // object, a number, or a megabyte of prose must never become one.
    for (const bad of [
      undefined,
      null,
      42,
      {},
      [],
      '',
      'x'.repeat(200),
      'has space',
      'has\nnewline',
    ]) {
      expect(readRequestId({ type: 'archive', requestId: bad }), String(bad)).toBeUndefined();
    }
  });

  it('is safe on a non-object', () => {
    expect(readRequestId(null)).toBeUndefined();
    expect(readRequestId('nope')).toBeUndefined();
  });
});

describe('reportAction', () => {
  it('acks a synchronous action that returns void', async () => {
    // A `void` return means "accepted" — the host handed the request on. That is
    // an honest, weaker claim than "completed", and it is what lets a control
    // leave pending instead of sitting there until the watchdog fires.
    const { post, sent } = collect();
    await reportAction('r1', post, () => {});
    expect(sent).toEqual([{ type: 'action-result', requestId: 'r1', ok: true }]);
  });

  it('reports the real outcome when the action returns a promise', async () => {
    const { post, sent } = collect();
    await reportAction('r1', post, async () => {
      await Promise.resolve();
    });
    expect(sent).toEqual([{ type: 'action-result', requestId: 'r1', ok: true }]);
  });

  it('reports failure when the promise rejects', async () => {
    const { post, sent } = collect();
    await reportAction('r1', post, async () => {
      throw new Error('gh refused the merge');
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.ok).toBe(false);
    expect(sent[0]!.message).toBe('gh refused the merge');
  });

  it('reports failure when the action throws synchronously', async () => {
    const { post, sent } = collect();
    await reportAction('r1', post, () => {
      throw new Error('no worktree');
    });
    expect(sent[0]).toEqual({
      type: 'action-result',
      requestId: 'r1',
      ok: false,
      message: 'no worktree',
    });
  });

  it('posts exactly one result per request', async () => {
    const { post, sent } = collect();
    await reportAction('r1', post, async () => {});
    expect(sent).toHaveLength(1);
  });

  it('does nothing when the webview sent no requestId', async () => {
    // Back-compat: a control not yet routed through the runtime still works, it
    // simply gets no result — which is exactly its behaviour today.
    const { post, sent } = collect();
    const run = vi.fn();
    await reportAction(undefined, post, run);
    expect(run).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(0);
  });

  it('still runs the action when posting the result throws', async () => {
    // A disposed panel throws on postMessage. Reporting is observation; it must
    // never be able to break the thing it observes.
    const run = vi.fn();
    await expect(
      reportAction(
        'r1',
        () => {
          throw new Error('panel disposed');
        },
        run,
      ),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it('collapses and caps untrusted failure prose (UI-R32)', async () => {
    // A 429 from the Claude CLI is a ~2KB JSON envelope. That blob reached a
    // ship verdict once and read as an internal crash; it must not now reach a
    // toast.
    const { post, sent } = collect();
    await reportAction('r1', post, async () => {
      throw new Error(`line one\n\tline two   ${'x'.repeat(4000)}`);
    });
    const message = sent[0]!.message!;
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\t');
    expect(message.length).toBeLessThanOrEqual(MAX_RESULT_MESSAGE_CHARS);
  });

  it('survives a thrown non-Error', async () => {
    const { post, sent } = collect();
    await reportAction('r1', post, () => {
      throw 'a bare string';
    });
    expect(sent[0]!.ok).toBe(false);
    expect(sent[0]!.message).toBe('a bare string');
  });

  it('never reports a bare empty message', async () => {
    const { post, sent } = collect();
    await reportAction('r1', post, () => {
      throw new Error('   ');
    });
    expect(sent[0]!.ok).toBe(false);
    expect(sent[0]!.message).toBeUndefined();
  });
});
