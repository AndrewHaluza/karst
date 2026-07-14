import { describe, it, expect, vi } from 'vitest';
import { buildWelcomeActions, type WelcomeActionsCtx } from './actions.js';
import type { WelcomeHostMessage } from './messages.js';

function makeCtx() {
  const posted: WelcomeHostMessage[] = [];
  const pushState = vi.fn();
  const ctx: WelcomeActionsCtx = { post: (m) => posted.push(m), pushState };
  return { ctx, posted, pushState };
}

describe('buildWelcomeActions', () => {
  it('createManifest scaffolds then re-pushes state', async () => {
    const scaffoldManifest = vi.fn().mockResolvedValue(undefined);
    const { ctx, pushState } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest, setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    await actions.createManifest();
    expect(scaffoldManifest).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('createManifest posts an error when the scaffold throws', async () => {
    const scaffoldManifest = vi.fn().mockRejectedValue(new Error('disk full'));
    const { ctx, posted } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest, setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    await actions.createManifest();
    expect(posted).toContainEqual({ type: 'error', message: 'disk full' });
  });

  it('recheckDeps re-pushes state', () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    actions.recheckDeps();
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('openSettings and createTicket run the matching commands', () => {
    const runCommand = vi.fn();
    const { ctx } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand })(ctx);
    actions.openSettings();
    actions.createTicket();
    expect(runCommand).toHaveBeenCalledWith('karst.openSettings');
    expect(runCommand).toHaveBeenCalledWith('karst.createTicket');
  });

  it('dismiss sets the dismissed flag', () => {
    const setDismissed = vi.fn();
    const { ctx } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest: vi.fn(), setDismissed, runCommand: vi.fn() })(ctx);
    actions.dismiss();
    expect(setDismissed).toHaveBeenCalledOnce();
  });

  it('requestState re-pushes state', () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    actions.requestState();
    expect(pushState).toHaveBeenCalledOnce();
  });
});
