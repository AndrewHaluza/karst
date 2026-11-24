import { describe, it, expect, vi } from 'vitest';
import { buildGettingStartedActions, GETTING_STARTED_DISMISS_MESSAGE, type GettingStartedActionsCtx } from './actions.js';

function makeCtx() {
  const pushState = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const ctx: GettingStartedActionsCtx = { pushState, close };
  return { ctx, pushState, close };
}

const noopDeps = () => ({
  scaffoldManifest: vi.fn().mockResolvedValue(undefined),
  setDismissed: vi.fn(),
  notify: vi.fn(),
  runCommand: vi.fn(),
});

describe('buildGettingStartedActions', () => {
  it('createManifest scaffolds then re-pushes state', async () => {
    const deps = noopDeps();
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions(deps)(ctx);
    await actions.createManifest();
    expect(deps.scaffoldManifest).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('createManifest re-pushes state before its result, so no button settles on a stale checklist', async () => {
    const deps = noopDeps();
    const { ctx } = makeCtx();
    const order: string[] = [];
    const actions = buildGettingStartedActions({
      ...deps,
      scaffoldManifest: async () => {
        order.push('scaffold');
      },
    })({
      ...ctx,
      pushState: async () => {
        order.push('state');
      },
    });
    await actions.createManifest();
    expect(order).toEqual(['scaffold', 'state']);
  });

  it('createManifest rejects (without pushing state) when the scaffold throws', async () => {
    // No local try/catch any more: the rejection propagates to the single
    // dispatch seam (panel.ts), which reports it as the terminal
    // `action-result` instead of the old bespoke `{type:'error'}` push
    // (UI-R13).
    const deps = { ...noopDeps(), scaffoldManifest: vi.fn().mockRejectedValue(new Error('disk full')) };
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions(deps)(ctx);
    await expect(actions.createManifest()).rejects.toThrow('disk full');
    expect(pushState).not.toHaveBeenCalled();
  });

  it('recheckDeps returns the state push, so its result comes after the state post (GS-3)', async () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions(noopDeps())(ctx);
    await actions.recheckDeps();
    expect(pushState).toHaveBeenCalledExactlyOnceWith({ recheck: true });
  });

  it('requestState and createManifest push without a re-check, so the cache is read', async () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions(noopDeps())(ctx);
    actions.requestState();
    await actions.createManifest();
    expect(pushState).toHaveBeenCalledTimes(2);
    for (const call of pushState.mock.calls) expect(call[0]?.recheck).not.toBe(true);
  });

  it('openSettings, createTicket and setupAgent run the matching commands', () => {
    const deps = noopDeps();
    const { ctx } = makeCtx();
    const actions = buildGettingStartedActions(deps)(ctx);
    actions.openSettings();
    actions.createTicket();
    actions.setupAgent();
    expect(deps.runCommand).toHaveBeenCalledWith('karst.openSettings');
    expect(deps.runCommand).toHaveBeenCalledWith('karst.openTicketForm');
    expect(deps.runCommand).toHaveBeenCalledWith('karst.setupAgent');
  });

  it('reportIssue runs the existing report-issue command rather than a second reporting path', () => {
    // The Getting Started entry is a jump-off point, not a new destination: it
    // hands over to `karst.reportIssue`, which is the one flow that redacts,
    // finalizes and prefills the GitHub handoff (§ issue reporting).
    const deps = noopDeps();
    const { ctx } = makeCtx();
    const actions = buildGettingStartedActions(deps)(ctx);
    actions.reportIssue();
    expect(deps.runCommand).toHaveBeenCalledWith('karst.reportIssue');
  });

  it('reportIssue does not dismiss the page or re-push state — reporting is not setup progress', () => {
    const deps = noopDeps();
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions(deps)(ctx);
    actions.reportIssue();
    expect(deps.setDismissed).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });

  // GS-8: "Don't show this again" used to leave the page open with no word on
  // how to get it back. It now stores the flag, says what happened, then closes.
  it('dismiss stores the flag, tells the user, then closes — in that order', () => {
    const order: string[] = [];
    const deps = {
      ...noopDeps(),
      setDismissed: () => void order.push('dismissed'),
      notify: () => void order.push('notify'),
    };
    const { ctx } = makeCtx();
    const actions = buildGettingStartedActions(deps)({
      ...ctx,
      close: () => void order.push('close'),
    });
    actions.dismiss();
    expect(order).toEqual(['dismissed', 'notify', 'close']);
  });

  it('dismiss says how to open the page again', () => {
    const deps = noopDeps();
    const { ctx } = makeCtx();
    buildGettingStartedActions(deps)(ctx).dismiss();
    expect(deps.notify).toHaveBeenCalledWith(GETTING_STARTED_DISMISS_MESSAGE);
    expect(GETTING_STARTED_DISMISS_MESSAGE).toBe(
      "Getting Started will not open at start-up. Run 'Karst: Getting Started' to open it.",
    );
  });

  it('requestState re-pushes state', () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions(noopDeps())(ctx);
    actions.requestState();
    expect(pushState).toHaveBeenCalledOnce();
  });
});
