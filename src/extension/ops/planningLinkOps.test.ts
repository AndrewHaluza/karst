/**
 * `P<n>` link host calls (T1400): a failure is logged AND re-thrown, because the panel reports the
 * returned promise as the action's outcome — a swallowed rejection would be posted as `ok: true`
 * (`@ui:UI-R13`).
 */
import { describe, it, expect, vi } from 'vitest';
import { makePlanningLinkActions } from './planningLinkOps.js';

function host() {
  return { open: vi.fn<() => Promise<void>>(), openArtifacts: vi.fn<() => Promise<void>>() };
}

describe('makePlanningLinkActions (UI-R13)', () => {
  it('opens the session and settles when the host succeeds', async () => {
    const h = host();
    h.open.mockResolvedValue(undefined);
    h.openArtifacts.mockResolvedValue(undefined);
    const logError = vi.fn();
    const actions = makePlanningLinkActions(h, logError);
    await expect(actions.planOpen(17)).resolves.toBeUndefined();
    await expect(actions.planArtifacts(17)).resolves.toBeUndefined();
    expect(h.open).toHaveBeenCalledWith(17);
    expect(h.openArtifacts).toHaveBeenCalledWith(17);
    expect(logError).not.toHaveBeenCalled();
  });

  it('logs a failed open and rejects with the same error, so the result is not posted as success', async () => {
    const h = host();
    const failure = new Error('no workspace folder');
    h.open.mockRejectedValue(failure);
    const logError = vi.fn();
    const actions = makePlanningLinkActions(h, logError);
    await expect(actions.planOpen(17)).rejects.toBe(failure);
    expect(logError).toHaveBeenCalledWith('planning: open failed', failure);
  });

  it('logs a failed artifacts open and rejects with the same error', async () => {
    const h = host();
    const failure = new Error('session folder is gone');
    h.openArtifacts.mockRejectedValue(failure);
    const logError = vi.fn();
    const actions = makePlanningLinkActions(h, logError);
    await expect(actions.planArtifacts(9)).rejects.toBe(failure);
    expect(logError).toHaveBeenCalledWith('planning: open artifacts failed', failure);
  });
});
