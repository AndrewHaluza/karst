import { describe, expect, it } from 'vitest';
import { REFRESH_DIRTY, REFRESH_DIVERGED, STASH_REFRESH_SCRIPT, refreshOutcome, stashMessage } from './cloneRefresh.js';

describe('refreshOutcome', () => {
  it('maps every exit code', () => {
    expect(refreshOutcome(0, '', '', 'b')).toEqual({ ok: true, summary: 'refreshed the sandbox clone of b from the host' });
    expect(refreshOutcome(REFRESH_DIRTY, ' M f\n', '', 'b')).toEqual({ ok: false, reason: 'the sandbox clone has uncommitted work; nothing was overwritten:\nM f' });
    expect(refreshOutcome(REFRESH_DIRTY, 'karst-host-ahead 3\n M f\n', '', 'b')).toEqual({ ok: false, reason: 'sandbox has uncommitted work and the host is ahead by 3 commit(s); nothing was overwritten:\nM f' });
    expect(refreshOutcome(REFRESH_DIRTY, 'karst-host-ahead 0\n M f\n', '', 'b')).toEqual({ ok: false, reason: 'the sandbox clone has uncommitted work; nothing was overwritten:\nM f' });
    expect(refreshOutcome(5, '', 'boom', 'b')).toEqual({ ok: false, reason: 'sandbox stash failed; nothing was changed: boom' });
    expect(refreshOutcome(REFRESH_DIVERGED, '', '', 'b')).toEqual({ ok: false, reason: "refused: the host's b diverged from the sandbox clone (never forced)" });
    expect(refreshOutcome(1, 'out', 'err', 'b')).toEqual({ ok: false, reason: 'sandbox refresh failed: err' });
    expect(refreshOutcome(1, 'out', '', 'b')).toEqual({ ok: false, reason: 'sandbox refresh failed: out' });
  });
});

describe('stash script', () => {
  it('refuses (fetch, ancestor) before it stashes', () => {
    const at = (needle: string) => STASH_REFRESH_SCRIPT.indexOf(needle);
    expect(at('git fetch')).toBeLessThan(at('git stash push'));
    expect(at('--is-ancestor')).toBeLessThan(at('git stash push'));
    expect(at('git stash push')).toBeLessThan(at('git merge -q'));
  });
  it('a failure after the stash still says where the work went', () => {
    expect(refreshOutcome(1, 'karst-stashed\n', 'ff failed', 'b')).toEqual({
      ok: false,
      reason: "sandbox refresh failed: ff failed\nThe sandbox's uncommitted work was already stashed: see `git stash list` inside the sandbox.",
    });
    expect(refreshOutcome(1, '', 'ff failed', 'b')).toEqual({ ok: false, reason: 'sandbox refresh failed: ff failed' });
  });
});

describe('stashMessage', () => {
  it('names the ticket and the time', () => {
    expect(stashMessage('T9', new Date('2026-10-21T10:00:00.000Z'))).toBe('karst: T9 before host update 2026-10-21T10:00:00.000Z');
  });
  it('the stash script never discards: no reset or clean', () => {
    expect(STASH_REFRESH_SCRIPT).not.toMatch(/reset|clean|checkout/);
    expect(STASH_REFRESH_SCRIPT).toContain('git stash push -u -m "$3"');
  });
});
