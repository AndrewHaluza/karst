/**
 * The rows of the Servers panel on the shared Row pattern: a ticket service, a shared (baseline)
 * service. A status is never colour-only: a dot with its own shape AND, for any state but running, its word.
 */
import { memo, useCallback, type ReactNode } from 'react';
import type { DashboardState } from '../state.js';
import { useOverlays } from './DashboardAppContext.js';
import type { DashboardSender } from './hostBridge.js';
import { Row } from './Row.js';
import { AddressLink, CopyAction, LocalAction, PostAction } from './ServerActions.js';
import { structurallyEqual } from './useSlice.js';

export type OwnServer = DashboardState['servers'][number];
export type SharedServer = DashboardState['sharedServers'][number];

type Addressable = Pick<OwnServer, 'host' | 'port' | 'status'>;

export const isOnline = (s: Addressable): boolean => s.status === 'running';
const addrOf = (s: Addressable): string => `${s.host || 'localhost'}:${s.port}`;

/** role=img + aria-label keeps a bare dot from being invisible to a screen reader; filled disc vs hollow ring still differ without colour. */
function Dot({ kind, word }: { readonly kind: 'on' | 'failed' | 'off'; readonly word: string }) {
  return <span className={`glyph ${kind}`} role="img" aria-label={word} title={word} />;
}

/** The status in words, beside the dot: running rows need none (the address says it). */
function Word({ word, tone }: { readonly word: string; readonly tone: 'failed' | 'off' }) {
  return <span className={`srvword ${tone}`}>{word}</span>;
}

interface RowProps<T> {
  readonly s: T;
  readonly send: DashboardSender;
}
const sameRow = <T,>(a: RowProps<T>, b: RowProps<T>): boolean => a.send === b.send && structurallyEqual(a.s, b.s);

export const ServerRow = memo(function ServerRow({ s, send }: RowProps<OwnServer>) {
  const on = isOnline(s);
  const failed = s.status === 'failed';
  const status = on ? 'running' : failed ? 'failed' : 'offline';
  const id = s.id;
  const logs = useOverlays().openLogs;
  const open = useCallback((r: string) => send.openServer(id, r), [send, id]);
  const copy = useCallback((r: string) => send.copyServerUrl(id, r), [send, id]);
  const restart = useCallback((r: string) => send.restartServer(id, r), [send, id]);
  const stop = useCallback((r: string) => send.stopServer(id, r), [send, id]);
  const start = useCallback((r: string) => send.startServer(id, r), [send, id]);
  const trail: ReactNode = on ? (
    <>
      <PostAction data-act="restart-server" id={id} label="Restart" icon="refresh" post={restart} />
      <PostAction data-act="stop-server" id={id} label="Stop" icon="player-stop" post={stop} />
    </>
  ) : (
    <>
      {failed ? <LocalAction data-act="server-logs-request" label="View server logs" icon="terminal-2" run={logs} /> : null}
      <PostAction data-act="start-server" id={id} label="Start service" icon="player-play" post={start} />
    </>
  );
  return (
    <Row data-row={`srv-${id}`} lead={<Dot kind={on ? 'on' : failed ? 'failed' : 'off'} word={status} />} trail={trail}>
      <span className="srvname" title={s.service}>
        {s.service}
      </span>
      {on ? (
        <>
          <AddressLink data-act="open-server" id={id} text={addrOf(s)} short={`:${s.port}`} title={`Open ${addrOf(s)} in the browser`} post={open} />
          <CopyAction data-act="copy-server-url" id={id} label="Copy URL" icon="copy" post={copy} />
        </>
      ) : (
        <Word word={status} tone={failed ? 'failed' : 'off'} />
      )}
    </Row>
  );
}, sameRow);

/** A shared row's status, in words: the dot is never the only carrier. */
const sharedWord = (s: SharedServer): string => (s.status === 'running' || s.status === 'failed' || s.status === 'missing' ? s.status : 'stopped');
export const isSharedFault = (s: SharedServer): boolean => s.status === 'failed' || s.status === 'missing';

/**
 * One shared (baseline) row: read-only. The address opens it while it runs; Logs only when it has a file;
 * Manage is always there. No start/stop/restart on purpose: a stop affects every other ticket, so it
 * lives behind the project view's host confirm (UI-R33).
 */
export const SharedRow = memo(function SharedRow({ s, send }: RowProps<SharedServer>) {
  const on = isOnline(s);
  const word = sharedWord(s);
  const fault = isSharedFault(s);
  const id = s.id;
  const open = useCallback((r: string) => send.openServer(id ?? 0, r), [send, id]);
  const manage = useCallback((r: string) => send.openResources(r), [send]);
  const logs = useOverlays().openLogs;
  const sub = s.missingReason ? <span className="srvnote fault">{s.missingReason}</span> : s.sharedWith ? <span className="srvnote">{s.sharedWith}</span> : null;
  return (
    <Row
      data-row={`shared-${s.service}`}
      lead={<Dot kind={on ? 'on' : fault ? 'failed' : 'off'} word={word} />}
      sub={sub}
      trail={
        <>
          {s.logPath ? <LocalAction data-act="server-logs-request" label="View server logs" icon="terminal-2" run={logs} /> : null}
          <PostAction data-act="open-resources" label="Manage shared services" icon="settings" post={manage} />
        </>
      }
    >
      <span className="srvname" title={s.service}>
        {s.service}
      </span>
      {s.baseBranch ? <span className="srvbranch k-chip">{s.baseBranch}</span> : null}
      {on && id != null ? <AddressLink data-act="open-server" id={id} text={addrOf(s)} short={`:${s.port}`} title={`Open ${addrOf(s)} in the browser`} post={open} /> : null}
      {on && id == null ? <span className="srvaddr plain">{addrOf(s)}</span> : null}
      {on ? null : <Word word={word} tone={fault ? 'failed' : 'off'} />}
    </Row>
  );
}, sameRow);
