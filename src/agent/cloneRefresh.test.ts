import { describe, expect, it } from 'vitest';
import { REFRESH_DIRTY, REFRESH_DIVERGED, refreshOutcome } from './cloneRefresh.js';

describe('refreshOutcome', () => {
  it('maps every exit code', () => {
    expect(refreshOutcome(0, '', '', 'b')).toEqual({ ok: true, summary: 'refreshed the sandbox clone of b from the host' });
    expect(refreshOutcome(REFRESH_DIRTY, ' M f\n', '', 'b')).toEqual({ ok: false, reason: 'the sandbox clone has uncommitted work; nothing was overwritten:\nM f' });
    expect(refreshOutcome(REFRESH_DIVERGED, '', '', 'b')).toEqual({ ok: false, reason: "refused: the host's b diverged from the sandbox clone (never forced)" });
    expect(refreshOutcome(1, 'out', 'err', 'b')).toEqual({ ok: false, reason: 'sandbox refresh failed: err' });
    expect(refreshOutcome(1, 'out', '', 'b')).toEqual({ ok: false, reason: 'sandbox refresh failed: out' });
  });
});
