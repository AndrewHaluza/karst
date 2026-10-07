import { describe, expect, it, vi } from 'vitest';

import type { Notify } from './notify.js';
import { warnBaseNotPulled } from './baseNotPulled.js';

function fakeNotify(): Notify {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
}

describe('warnBaseNotPulled', () => {
  it('reports the same message to the channel and the user toast', () => {
    const warn = vi.fn();
    const notify = fakeNotify();

    warnBaseNotPulled('/repos/api', 'develop', 'fatal: could not read', { warn, notify });

    const message =
      'Could not refresh develop in /repos/api — the worktree was created from the local branch: fatal: could not read';
    expect(warn).toHaveBeenCalledWith(message);
    expect(notify.warn).toHaveBeenCalledWith(message);
  });
});
