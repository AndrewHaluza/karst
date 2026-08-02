import { describe, it, expect, vi } from 'vitest';
import { buildGettingStartedActions, type GettingStartedActionsCtx } from './actions.js';

function makeCtx() {
  const pushState = vi.fn();
  const ctx: GettingStartedActionsCtx = { pushState };
  return { ctx, pushState };
}

describe('buildGettingStartedActions', () => {
  it('createManifest scaffolds then re-pushes state', async () => {
    const scaffoldManifest = vi.fn().mockResolvedValue(undefined);
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions({ scaffoldManifest, setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    await actions.createManifest();
    expect(scaffoldManifest).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('createManifest rejects (without pushing state) when the scaffold throws', async () => {
    // No local try/catch any more: the rejection propagates to the single
    // dispatch seam (panel.ts), which reports it as the terminal
    // `action-result` instead of the old bespoke `{type:'error'}` push
    // (UI-R13).
    const scaffoldManifest = vi.fn().mockRejectedValue(new Error('disk full'));
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions({ scaffoldManifest, setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    await expect(actions.createManifest()).rejects.toThrow('disk full');
    expect(pushState).not.toHaveBeenCalled();
  });

  it('recheckDeps re-pushes state', () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    actions.recheckDeps();
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('openSettings and createTicket run the matching commands', () => {
    const runCommand = vi.fn();
    const { ctx } = makeCtx();
    const actions = buildGettingStartedActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand })(ctx);
    actions.openSettings();
    actions.createTicket();
    expect(runCommand).toHaveBeenCalledWith('karst.openSettings');
    expect(runCommand).toHaveBeenCalledWith('karst.createTicket');
  });

  it('reportIssue runs the existing report-issue command rather than a second reporting path', () => {
    // The Getting Started entry is a jump-off point, not a new destination: it
    // hands over to `karst.reportIssue`, which is the one flow that redacts,
    // finalizes and prefills the GitHub handoff (§ issue reporting).
    const runCommand = vi.fn();
    const { ctx } = makeCtx();
    const actions = buildGettingStartedActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand })(ctx);
    actions.reportIssue();
    expect(runCommand).toHaveBeenCalledWith('karst.reportIssue');
  });

  it('reportIssue does not dismiss the page or re-push state — reporting is not setup progress', () => {
    const setDismissed = vi.fn();
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions({ scaffoldManifest: vi.fn(), setDismissed, runCommand: vi.fn() })(ctx);
    actions.reportIssue();
    expect(setDismissed).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('dismiss sets the dismissed flag', () => {
    const setDismissed = vi.fn();
    const { ctx } = makeCtx();
    const actions = buildGettingStartedActions({ scaffoldManifest: vi.fn(), setDismissed, runCommand: vi.fn() })(ctx);
    actions.dismiss();
    expect(setDismissed).toHaveBeenCalledOnce();
  });

  it('requestState re-pushes state', () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildGettingStartedActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    actions.requestState();
    expect(pushState).toHaveBeenCalledOnce();
  });
});
