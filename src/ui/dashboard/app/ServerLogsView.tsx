/**
 * Combined server logs: the surface itself (tabs, search, run scoping, ANSI rendering) is the shared
 * `window.createServerLogsView` runtime injected into the page, included by both this dashboard and the standalone logs
 * panel. It draws into the static `#logsView` root by id and toggles that root's `hidden` and `body.log-nav` itself, so
 * this is a thin wrapper: it owns the runtime's lifecycle (opened on mount, closed on unmount) and routes the host's
 * answers to it. The overlay stack owns only the open flag and the Escape chain.
 *
 * The runtime posts through the `post` it is handed. Route its one message to the typed sender rather than exposing a raw
 * post: detach asks the host to open the standalone logs panel; its normal close arrives as `onClose`.
 *
 * One runtime instance serves every open: it binds listeners to the root element each time its shell is built, so a
 * second instance would act on the first one's DOM.
 */
import { useEffect, useRef } from 'react';
import type { ServerLogEntry } from '../messages.js';
import { useDashboardSend, useHostMessage, useOverlays } from './DashboardAppContext.js';
import { fromIsland } from './islands.js';
import './ServerLogsView.css';

interface LogsView {
  open(): void;
  close(): void;
  handleInitial(servers: readonly ServerLogEntry[]): void;
  handleOutput(service: string, text: string): void;
}
type LogsFactory = (options: { post: (msg: { type?: string } | null) => void; onClose: () => void }) => LogsView;

let cached: { factory: LogsFactory; view: LogsView; closed: { current: () => void } } | null = null;

/** The page's one runtime instance, built on first use; its close notification goes to whichever mount is current. */
function acquire(post: (msg: { type?: string } | null) => void): { view: LogsView; closed: { current: () => void } } | null {
  const factory = (globalThis as { createServerLogsView?: LogsFactory }).createServerLogsView;
  if (typeof factory !== 'function') return null;
  if (!cached || cached.factory !== factory) {
    const closed = { current: (): void => undefined };
    cached = { factory, view: factory({ post, onClose: () => closed.current() }), closed };
  }
  return cached;
}

/** PageUp/PageDown/Home/End scroll the log host, which takes no stdin of its own to page with. */
function scrollLogsByKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const host = document.getElementById('logsHost');
  if (!host) return false;
  const page = Math.max(host.clientHeight - 40, 40);
  if (e.key === 'PageUp') host.scrollTop -= page;
  else if (e.key === 'PageDown') host.scrollTop += page;
  else if (e.key === 'Home') host.scrollTop = 0;
  else if (e.key === 'End') host.scrollTop = host.scrollHeight;
  else return false;
  return true;
}

export function ServerLogsView() {
  const send = useDashboardSend();
  const overlays = useOverlays();
  const view = useRef<LogsView | null>(null);

  useEffect(() => {
    const post = (msg: { type?: string } | null): void => {
      if (msg && msg.type === 'server-logs-detach') send.serverLogsDetach();
      else if (msg && msg.type === 'server-logs-close') send.serverLogsClose();
    };
    const acquired = acquire(post);
    if (!acquired) return undefined;
    let closed = false;
    // The runtime's own Close (or this cleanup): the stack follows, and the host stops tailing, once.
    acquired.closed.current = () => {
      closed = true;
      overlays.closeLogs();
      send.serverLogsClose();
    };
    view.current = acquired.view;
    acquired.view.open();
    send.serverLogsRequest();
    return () => {
      view.current = null;
      if (!closed) acquired.view.close();
    };
  }, [send, overlays]);

  useHostMessage((m) => {
    if (m.type === 'server-logs') view.current?.handleInitial(m.servers || []);
    else if (m.type === 'server-log-output') view.current?.handleOutput(m.service, m.text);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!fromIsland(e) && scrollLogsByKey(e)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return null;
}
