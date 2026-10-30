import { describe, it, expect, vi } from 'vitest';
import { parseSidebarMessage, routeSidebarAction, type SidebarActions } from './messages.js';

describe('parseSidebarMessage', () => {
  it('accepts payload-free messages', () => {
    for (const type of ['refresh', 'request-state', 'create', 'open-settings', 'open-resources', 'open-token-usage'] as const) {
      expect(parseSidebarMessage({ type })).toEqual({ type });
    }
  });

  it('accepts planning-session messages only with a finite numeric sessionId', () => {
    expect(parseSidebarMessage({ type: 'plan-create' })).toEqual({ type: 'plan-create' });
    expect(parseSidebarMessage({ type: 'plan-open', sessionId: 3 })).toEqual({ type: 'plan-open', sessionId: 3 });
    expect(parseSidebarMessage({ type: 'plan-archive', sessionId: 3 })).toEqual({ type: 'plan-archive', sessionId: 3 });
    expect(parseSidebarMessage({ type: 'plan-unarchive', sessionId: 3 })).toEqual({ type: 'plan-unarchive', sessionId: 3 });
    expect(parseSidebarMessage({ type: 'plan-unarchive', sessionId: Infinity })).toBeNull();
    expect(parseSidebarMessage({ type: 'plan-open', sessionId: '3' })).toBeNull();
    expect(parseSidebarMessage({ type: 'plan-archive', ticketId: 3 })).toBeNull();
  });

  it('accepts proposal review/discard only with a finite numeric proposalId', () => {
    expect(parseSidebarMessage({ type: 'plan-proposal-review', proposalId: 4 })).toEqual({ type: 'plan-proposal-review', proposalId: 4 });
    expect(parseSidebarMessage({ type: 'plan-proposal-discard', proposalId: 4 })).toEqual({ type: 'plan-proposal-discard', proposalId: 4 });
    expect(parseSidebarMessage({ type: 'plan-proposal-review', proposalId: '4' })).toBeNull();
    expect(parseSidebarMessage({ type: 'plan-proposal-discard', proposalId: NaN })).toBeNull();
    expect(parseSidebarMessage({ type: 'plan-proposal-discard', sessionId: 4 })).toBeNull();
  });

  it('accepts cloud-session messages only with a non-empty url and exactly one link target', () => {
    const url = 'https://claude.ai/code/session_a';
    expect(parseSidebarMessage({ type: 'cloud-session-open', url })).toEqual({ type: 'cloud-session-open', url });
    expect(parseSidebarMessage({ type: 'cloud-session-unlink', url })).toEqual({ type: 'cloud-session-unlink', url });
    expect(parseSidebarMessage({ type: 'cloud-session-open', url: '' })).toBeNull();
    expect(parseSidebarMessage({ type: 'cloud-session-open', url: 5 })).toBeNull();
    expect(parseSidebarMessage({ type: 'cloud-session-link', url, ticketId: 3 })).toEqual({ type: 'cloud-session-link', url, ticketId: 3 });
    expect(parseSidebarMessage({ type: 'cloud-session-link', url, proposalId: 4 })).toEqual({ type: 'cloud-session-link', url, proposalId: 4 });
    expect(parseSidebarMessage({ type: 'cloud-session-link', url, ticketId: 3, proposalId: 4 })).toBeNull();
    expect(parseSidebarMessage({ type: 'cloud-session-link', url })).toBeNull();
    expect(parseSidebarMessage({ type: 'cloud-session-link', url, ticketId: '3' })).toBeNull();
    expect(parseSidebarMessage({ type: 'cloud-session-link', url: '', ticketId: 3 })).toBeNull();
  });

  it('rejects the removed plan-proposal-view message', () => {
    expect(parseSidebarMessage({ type: 'plan-proposal-view', proposalId: 4 })).toBeNull();
  });

  it('accepts toggle-facet with a known facet, rejects unknown', () => {
    expect(parseSidebarMessage({ type: 'toggle-facet', facet: 'running' })).toEqual({
      type: 'toggle-facet',
      facet: 'running',
    });
    expect(parseSidebarMessage({ type: 'toggle-facet', facet: 'bogus' })).toBeNull();
    expect(parseSidebarMessage({ type: 'toggle-facet' })).toBeNull();
  });

  it('accepts set-filter with a string query', () => {
    expect(parseSidebarMessage({ type: 'set-filter', query: 'abc' })).toEqual({
      type: 'set-filter',
      query: 'abc',
    });
    expect(parseSidebarMessage({ type: 'set-filter', query: 5 })).toBeNull();
  });

  it('accepts row actions only with a finite numeric ticketId', () => {
    expect(parseSidebarMessage({ type: 'open-ticket', ticketId: 17 })).toEqual({
      type: 'open-ticket',
      ticketId: 17,
    });
    expect(parseSidebarMessage({ type: 'spin', ticketId: 3 })).toEqual({ type: 'spin', ticketId: 3 });
    expect(parseSidebarMessage({ type: 'open-ticket', ticketId: '17' })).toBeNull();
    expect(parseSidebarMessage({ type: 'archive', ticketId: '3' })).toBeNull();
    expect(parseSidebarMessage({ type: 'delete', ticketId: NaN })).toBeNull();
    expect(parseSidebarMessage({ type: 'edit' })).toBeNull();
  });

  it('accepts create-follow-up with a numeric ticketId', () => {
    expect(parseSidebarMessage({ type: 'create-follow-up', ticketId: 12 })).toEqual({
      type: 'create-follow-up',
      ticketId: 12,
    });
    expect(parseSidebarMessage({ type: 'create-follow-up', ticketId: '12' })).toBeNull();
  });

  it.each(['pause-ticket', 'unpause-ticket', 'close-ticket', 'reopen-ticket', 'detach-subtask', 'review-stall-hint', 'review-stall-continue', 'review-stall-rescope'] as const)(
    'accepts %s with a numeric ticketId and rejects anything else',
    (type) => {
      expect(parseSidebarMessage({ type, ticketId: 12 })).toEqual({ type, ticketId: 12 });
      expect(parseSidebarMessage({ type, ticketId: '12' })).toBeNull();
      expect(parseSidebarMessage({ type })).toBeNull();
    },
  );

  it('accepts resolve-conflicts with a numeric ticketId and a string repo', () => {
    expect(parseSidebarMessage({ type: 'resolve-conflicts', ticketId: 12, repo: 'api' })).toEqual({
      type: 'resolve-conflicts',
      ticketId: 12,
      repo: 'api',
    });
    expect(parseSidebarMessage({ type: 'resolve-conflicts', ticketId: 12 })).toBeNull();
    expect(parseSidebarMessage({ type: 'resolve-conflicts', ticketId: '12', repo: 'api' })).toBeNull();
  });

  it('accepts cloud-session-add with exactly one target', () => {
    expect(parseSidebarMessage({ type: 'cloud-session-add', ticketId: 3 })).toEqual({ type: 'cloud-session-add', ticketId: 3 });
    expect(parseSidebarMessage({ type: 'cloud-session-add', proposalId: 4 })).toEqual({ type: 'cloud-session-add', proposalId: 4 });
    expect(parseSidebarMessage({ type: 'cloud-session-add' })).toBeNull();
    expect(parseSidebarMessage({ type: 'cloud-session-add', ticketId: 3, proposalId: 4 })).toBeNull();
  });

  it('rejects non-objects and unknown types', () => {
    expect(parseSidebarMessage(null)).toBeNull();
    expect(parseSidebarMessage('x')).toBeNull();
    expect(parseSidebarMessage({ type: 'nope' })).toBeNull();
  });
});

describe('routeSidebarAction', () => {
  function makeActions(): SidebarActions {
    return {
      toggleFacet: vi.fn(),
      setFilter: vi.fn(),
      refresh: vi.fn(),
      requestState: vi.fn(),
      create: vi.fn(),
      openSettings: vi.fn(),
      openResources: vi.fn(),
      openTokenUsage: vi.fn(),
      openTicket: vi.fn(),
      openDashboard: vi.fn(),
      spin: vi.fn(),
      openSession: vi.fn(),
      edit: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      delete: vi.fn(),
      createFollowUp: vi.fn(),
      pauseTicket: vi.fn(),
      unpauseTicket: vi.fn(),
      closeTicket: vi.fn(),
      reopenTicket: vi.fn(),
      detachSubtask: vi.fn(),
      reviewStallHint: vi.fn(),
      reviewStallContinue: vi.fn(),
      reviewStallRescope: vi.fn(),
      resolveConflicts: vi.fn(),
      sendCiFailure: vi.fn(),
      planCreate: vi.fn(),
      planOpen: vi.fn(),
      planArchive: vi.fn(),
      planUnarchive: vi.fn(),
      planProposalReview: vi.fn(),
      planProposalDiscard: vi.fn(),
      cloudSessionOpen: vi.fn(),
      cloudSessionLink: vi.fn(),
      cloudSessionUnlink: vi.fn(),
      cloudSessionAdd: vi.fn(),
    };
  }

  it('dispatches each already-parsed message to its action with the right arg', () => {
    const a = makeActions();
    routeSidebarAction({ type: 'toggle-facet', facet: 'failed' }, a);
    routeSidebarAction({ type: 'set-filter', query: 'q' }, a);
    routeSidebarAction({ type: 'open-ticket', ticketId: 17 }, a);
    routeSidebarAction({ type: 'spin', ticketId: 7 }, a);
    routeSidebarAction({ type: 'archive', ticketId: 8 }, a);
    routeSidebarAction({ type: 'create' }, a);
    routeSidebarAction({ type: 'create-follow-up', ticketId: 12 }, a);
    routeSidebarAction({ type: 'pause-ticket', ticketId: 21 }, a);
    routeSidebarAction({ type: 'unpause-ticket', ticketId: 22 }, a);
    routeSidebarAction({ type: 'close-ticket', ticketId: 23 }, a);
    routeSidebarAction({ type: 'reopen-ticket', ticketId: 24 }, a);
    routeSidebarAction({ type: 'detach-subtask', ticketId: 25 }, a);
    routeSidebarAction({ type: 'review-stall-hint', ticketId: 26 }, a);
    routeSidebarAction({ type: 'review-stall-continue', ticketId: 27 }, a);
    routeSidebarAction({ type: 'review-stall-rescope', ticketId: 28 }, a);
    routeSidebarAction({ type: 'resolve-conflicts', ticketId: 12, repo: 'api' }, a);
    routeSidebarAction({ type: 'send-ci-failure', ticketId: 13 }, a);
    routeSidebarAction({ type: 'open-resources' }, a);
    routeSidebarAction({ type: 'open-token-usage' }, a);

    expect(a.toggleFacet).toHaveBeenCalledWith('failed');
    expect(a.setFilter).toHaveBeenCalledWith('q');
    expect(a.openTicket).toHaveBeenCalledWith(17);
    expect(a.spin).toHaveBeenCalledWith(7);
    expect(a.archive).toHaveBeenCalledWith(8);
    expect(a.create).toHaveBeenCalledOnce();
    expect(a.createFollowUp).toHaveBeenCalledWith(12);
    expect(a.pauseTicket).toHaveBeenCalledWith(21);
    expect(a.unpauseTicket).toHaveBeenCalledWith(22);
    expect(a.closeTicket).toHaveBeenCalledWith(23);
    expect(a.reopenTicket).toHaveBeenCalledWith(24);
    expect(a.detachSubtask).toHaveBeenCalledWith(25);
    expect(a.reviewStallHint).toHaveBeenCalledWith(26);
    expect(a.reviewStallContinue).toHaveBeenCalledWith(27);
    expect(a.reviewStallRescope).toHaveBeenCalledWith(28);
    expect(a.resolveConflicts).toHaveBeenCalledWith(12, 'api');
    expect(a.sendCiFailure).toHaveBeenCalledWith(13);
    expect(a.openResources).toHaveBeenCalledOnce();
    expect(a.openTokenUsage).toHaveBeenCalledOnce();
  });

  it('dispatches planning-session messages', () => {
    const a = makeActions();
    routeSidebarAction({ type: 'plan-create' }, a);
    routeSidebarAction({ type: 'plan-open', sessionId: 4 }, a);
    routeSidebarAction({ type: 'plan-archive', sessionId: 5 }, a);
    routeSidebarAction({ type: 'plan-unarchive', sessionId: 6 }, a);
    expect(a.planUnarchive).toHaveBeenCalledWith(6);
    expect(a.planCreate).toHaveBeenCalledOnce();
    expect(a.planOpen).toHaveBeenCalledWith(4);
    expect(a.planArchive).toHaveBeenCalledWith(5);
    routeSidebarAction({ type: 'plan-proposal-review', proposalId: 7 }, a);
    routeSidebarAction({ type: 'plan-proposal-discard', proposalId: 8 }, a);
    expect(a.planProposalReview).toHaveBeenCalledWith(7);
    expect(a.planProposalDiscard).toHaveBeenCalledWith(8);
  });

  it('dispatches cloud-session messages', () => {
    const a = makeActions();
    routeSidebarAction({ type: 'cloud-session-open', url: 'u1' }, a);
    routeSidebarAction({ type: 'cloud-session-unlink', url: 'u2' }, a);
    routeSidebarAction({ type: 'cloud-session-link', url: 'u3', ticketId: 9 }, a);
    routeSidebarAction({ type: 'cloud-session-link', url: 'u4', proposalId: 5 }, a);
    expect(a.cloudSessionOpen).toHaveBeenCalledWith('u1');
    expect(a.cloudSessionUnlink).toHaveBeenCalledWith('u2');
    routeSidebarAction({ type: 'cloud-session-add', ticketId: 3 }, a);
    expect(a.cloudSessionAdd).toHaveBeenCalledWith({ ticketId: 3 });
    expect(a.cloudSessionLink).toHaveBeenNthCalledWith(1, 'u3', { ticketId: 9 });
    expect(a.cloudSessionLink).toHaveBeenNthCalledWith(2, 'u4', { proposalId: 5 });
  });

  it('returns whatever the action returns, so the dispatch seam can await a real outcome', async () => {
    // The single dispatch seam (panel.ts) wraps this in `reportAction`, which
    // needs the underlying promise back to report a real terminal result
    // instead of acking before the action finishes (UI-R13).
    const pending = Promise.resolve();
    const a = makeActions();
    a.spin = vi.fn(() => pending);
    expect(routeSidebarAction({ type: 'spin', ticketId: 7 }, a)).toBe(pending);
    await pending;
  });
});
