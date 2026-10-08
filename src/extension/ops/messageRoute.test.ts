import { describe, expect, it, vi } from 'vitest';
import {
  mailPointer,
  notesPointer,
  makeRoutedDelivery,
  makeTerminalDelivery,
  type MessageDelivery,
} from '../../workflow/messageDelivery.js';
import { messageRouteFor } from './messageDeliveryOps.js';

const CORES = ['claude', 'codex', 'opencode', 'opencode2', 'antigravity'] as const;
const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };

function typedSpy(): MessageDelivery & { deliver: ReturnType<typeof vi.fn> } {
  return { deliver: vi.fn(() => 'delivered' as const) };
}

describe('messageRouteFor', () => {
  it('maps each core to its push channel or the typed fallback', () => {
    expect(messageRouteFor('claude', false)).toBe('hook-block');
    expect(messageRouteFor('codex', true)).toBe('hook-block');
    expect(messageRouteFor('codex', false)).toBe('typed');
    expect(messageRouteFor('opencode', false)).toBe('plugin-idle');
    expect(messageRouteFor('opencode2', true)).toBe('typed');
    expect(messageRouteFor('antigravity', true)).toBe('typed');
    expect(messageRouteFor(null, true)).toBe('typed');
    expect(messageRouteFor('nonsense', true)).toBe('typed');
  });
});

describe('makeRoutedDelivery — sender × recipient matrix', () => {
  // The sender's core never influences HOW the recipient is told (sending,
  // storage and reading are core-agnostic CLI + DB). Every pair must still end
  // in a pointer delivered through the recipient's route or a clean typed
  // fallback — never a dropped delivery.
  for (const sender of CORES) {
    for (const recipient of CORES) {
      it(`${sender} → ${recipient}: a pointer is pushed or typed, never dropped`, () => {
        const typed = typedSpy();
        const route = messageRouteFor(recipient, true);
        const delivery = makeRoutedDelivery({
          routeFor: () => route,
          isLive: () => true,
          graphOwned: () => false,
          isBusy: () => true,
          typed,
        });
        const pointer = mailPointer(3);
        const outcome = delivery.deliver(9, pointer);
        if (route === 'typed') {
          expect(outcome).toBe('delivered');
          expect(typed.deliver).toHaveBeenCalledWith(9, pointer);
        } else {
          // A push route only ARMS while the recipient is mid-turn.
          expect(outcome).toBe('armed');
          expect(typed.deliver).not.toHaveBeenCalled();
        }
      });
    }
  }

  it('follows the recipient core when it switches mid-ticket', () => {
    let core: string | null = 'codex';
    const typed = typedSpy();
    const delivery = makeRoutedDelivery({
      routeFor: () => messageRouteFor(core, true),
      isLive: () => true,
      graphOwned: () => false,
      isBusy: () => true,
      typed,
    });
    // A codex implement: the Stop-block route arms the push at turn end.
    expect(delivery.deliver(9, mailPointer(1))).toBe('armed');
    expect(typed.deliver).not.toHaveBeenCalled();
    // The fix round resumes on claude: still a hook-block route.
    core = 'claude';
    expect(delivery.deliver(9, mailPointer(2))).toBe('armed');
    expect(typed.deliver).not.toHaveBeenCalled();
    // A later switch to opencode2 has no push channel: typed.
    core = 'opencode2';
    expect(delivery.deliver(9, mailPointer(3))).toBe('delivered');
    expect(typed.deliver).toHaveBeenCalledWith(9, mailPointer(3));
  });

  it('defers a hook route when the recipient is not live', () => {
    const delivery = makeRoutedDelivery({
      routeFor: () => 'hook-block',
      isLive: () => false,
      graphOwned: () => false,
      isBusy: () => true,
      typed: typedSpy(),
    });
    expect(delivery.deliver(9, mailPointer(1))).toBe('deferred');
  });

  it('types an IDLE recipient on a push route instead of stranding the pointer', () => {
    const nudge = vi.fn(() => true);
    const typed = makeTerminalDelivery({
      isLive: () => true,
      graphOwned: () => false,
      nudge,
      sessionCliEnv: () => undefined,
      literal: () => LITERAL,
    });
    const delivery = makeRoutedDelivery({
      routeFor: () => 'hook-block',
      isLive: () => true,
      graphOwned: () => false,
      isBusy: () => false,
      typed,
    });
    expect(delivery.deliver(9, mailPointer(2))).toBe('delivered');
    expect(nudge).toHaveBeenCalledWith(9, expect.stringContaining('karst: 2 new message(s)'));
  });

  it('types the pointer with the RECIPIENT session env, never the sender', () => {
    const nudge = vi.fn(() => true);
    const typed = makeTerminalDelivery({
      isLive: () => true,
      graphOwned: () => false,
      nudge,
      sessionCliEnv: (id) => (id === 9 ? { cli: true, manifest: true, ticket: true } : undefined),
      literal: () => LITERAL,
    });
    const delivery = makeRoutedDelivery({
      routeFor: () => 'typed',
      isLive: () => true,
      graphOwned: () => false,
      isBusy: () => true,
      typed,
    });
    delivery.deliver(9, mailPointer(1));
    expect(nudge).toHaveBeenCalledWith(9, expect.stringContaining('"$KARST_CLI"'));
  });
});

describe('makeRoutedDelivery — notes pointers', () => {
  function routed(route: 'hook-block' | 'typed', over: { isLive?: boolean; isBusy?: boolean } = {}) {
    const typed = typedSpy();
    const delivery = makeRoutedDelivery({
      routeFor: () => route,
      isLive: () => over.isLive ?? true,
      graphOwned: () => false,
      isBusy: () => over.isBusy ?? true,
      typed,
    });
    return { delivery, typed };
  }

  it('a typed-route recipient gets the notes pointer typed', () => {
    const { delivery, typed } = routed('typed');
    expect(delivery.deliver(9, notesPointer(2))).toBe('delivered');
    expect(typed.deliver).toHaveBeenCalledWith(9, notesPointer(2));
  });

  it('an idle push-route recipient gets the notes pointer typed, never armed', () => {
    const { delivery, typed } = routed('hook-block', { isBusy: false });
    expect(delivery.deliver(9, notesPointer(2))).toBe('delivered');
    expect(typed.deliver).toHaveBeenCalledWith(9, notesPointer(2));
  });

  it('a busy push-route recipient defers the notes pointer (never armed)', () => {
    const { delivery, typed } = routed('hook-block', { isBusy: true });
    expect(delivery.deliver(9, notesPointer(2))).toBe('deferred');
    expect(typed.deliver).not.toHaveBeenCalled();
  });

  it('a notes pointer for a recipient that is not live defers', () => {
    const { delivery, typed } = routed('hook-block', { isLive: false, isBusy: false });
    expect(delivery.deliver(9, notesPointer(1))).toBe('deferred');
    expect(typed.deliver).not.toHaveBeenCalled();
  });
});
