/** Shared fixtures and harness for the overlay tests (drawer, console, logs, env editor, artifact view, the Escape chain). */
import { afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import type { HostMessage } from '../../messages.js';
import type { DashboardState } from '../../state.js';
import type { DashboardHostBridge, DashboardSender } from '../hostBridge.js';
import { DashboardAppProvider, useOverlays } from '../DashboardAppContext.js';
import type { PersistArt } from '../overlayStack.js';
import { tracePersist } from './persistTrace.js';
import type { OverlayStack } from '../overlayStack.js';
import { Overlays } from '../Overlays.js';

/** The static roots webview.html carries for the overlays, and the dashboard regions the body-nav classes hide. */
const ROOTS =
  '<div class="stepper"></div><div class="grid"></div>' +
  '<div id="ticketDataHost" class="tdHost"></div>' +
  '<div id="artView" class="artview hidden" tabindex="-1"></div>' +
  '<div id="termView" class="termview hidden" tabindex="-1"></div>' +
  '<div id="logsView" class="logsview hidden" tabindex="-1"></div>' +
  '<div id="envView" class="envview hidden" tabindex="-1"></div>';

const SENDERS = ['xtermRequest', 'stageLogRequest', 'agentLogRequest', 'serverLogsRequest', 'serverLogsClose', 'serverLogsDetach', 'envOverridesSave', 'openPr', 'insideAction', 'artifactOpenResource', 'storedArtifactOpen', 'storedArtifactDiff', 'storedArtifactLive', 'storedArtifactReveal', 'storedArtifactPurge'] as const;

export interface OverlayHarness {
  readonly send: Record<(typeof SENDERS)[number], ReturnType<typeof vi.fn>>;
  readonly emit: (message: HostMessage) => void;
  readonly overlays: OverlayStack;
  /** The artifact view and scroll memory written with the view state, per change. */
  readonly persisted: PersistArt[];
  /** Run store calls the way an opener's click does (inside act). */
  readonly act: (fn: () => void) => void;
}

export interface MountOptions {
  /** The persisted view state `bridge.getState()` hands back (besides `state`). */
  readonly persisted?: Record<string, unknown>;
}

const cleanups: Array<() => void> = [];

export function mountOverlays(initial: DashboardState | null, opts: MountOptions = {}): OverlayHarness {
  document.body.innerHTML = ROOTS;
  document.documentElement.scrollTop = 0;
  let listener: ((message: HostMessage) => void) | null = null;
  const send = Object.fromEntries(SENDERS.map((name) => [name, vi.fn()])) as OverlayHarness['send'];
  const trace = tracePersist(opts.persisted);
  const bridge: DashboardHostBridge = {
    send: send as unknown as DashboardSender,
    getState: () => (initial ? { state: initial, ...opts.persisted } : null),
    setState: trace.setState,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };

  let overlays: OverlayStack | null = null;
  function Probe(): null {
    const stack = useOverlays();
    useEffect(() => {
      overlays = stack;
    }, [stack]);
    return null;
  }
  render(
    <DashboardAppProvider bridge={bridge}>
      <Probe />
      <Overlays />
    </DashboardAppProvider>,
  );
  return { send, persisted: trace.art, overlays: overlays!, emit: (message) => act(() => listener?.(message)), act: (fn) => act(fn) };
}

/** The design-system runtime's pending primitives and identity helpers, as doubles. */
const pending = new Map<Element, string>();
beforeEach(() => {
  pending.clear();
  let n = 0;
  Object.assign(globalThis, {
    karstRequestId: () => `req-${++n}`,
    karstIsPending: (el: Element) => pending.has(el),
    // The page settles a control from the host's `action-result`; tests that play the host call this the same way.
    karstSettle: (requestId: string) => {
      for (const [el, id] of [...pending]) {
        if (id !== requestId) continue;
        pending.delete(el);
        el.classList.remove('is-pending');
        el.removeAttribute('aria-busy');
      }
    },
    karstBeginPending: (el: Element, requestId: string) => {
      pending.set(el, requestId);
      el.classList.add('is-pending');
      el.setAttribute('aria-busy', 'true');
    },
    karstIcon: (name: string) =>
      `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path data-icon="${name}"/></svg>`,
    agentIconHtml: (p: string) => `<span class="agenticon" aria-hidden="true"><svg data-p="${p}"></svg></span>`,
  });
});

afterEach(() => {
  cleanup();
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  document.body.className = '';
});

/** A key press on the page, the way a user's reaches the document (inside act, so React has flushed when it returns). */
export function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(e));
  return e;
}

export const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
export const must = <T extends Element = HTMLElement>(sel: string): T => {
  const el = q<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
export const all = <T extends Element = HTMLElement>(sel: string): T[] => [...document.querySelectorAll<T>(sel)];
export const text = (sel: string): string => q(sel)?.textContent ?? '';
export const isHidden = (sel: string): boolean => must(sel).classList.contains('hidden');
export const bodyHas = (cls: string): boolean => document.body.classList.contains(cls);
