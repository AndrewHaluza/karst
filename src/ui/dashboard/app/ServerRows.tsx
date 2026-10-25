/**
 * The rows of the Servers table: a ticket service, a shared (baseline) service and a group's
 * caption row. Same DOM, classes and ARIA as the vanilla `serverRow` / `sharedRow` /
 * `serverGroupHead` they replaced.
 */
import { memo, useCallback, type ReactNode } from 'react';
import type { DashboardState } from '../state.js';
import { useOverlays } from './DashboardAppContext.js';
import type { DashboardSender } from './hostBridge.js';
import { CopyAction, LocalAction, PostAction } from './ServerActions.js';
import { structurallyEqual } from './useSlice.js';

export type OwnServer = DashboardState['servers'][number];
export type SharedServer = DashboardState['sharedServers'][number];

type Addressable = Pick<OwnServer, 'host' | 'port' | 'status'>;

export const isOnline = (s: Addressable): boolean => s.status === 'running';
const addrOf = (s: Addressable): string => `${s.host || 'localhost'}:${s.port}`;

function Address({ s, tail }: { readonly s: Addressable; readonly tail: ReactNode }) {
  const on = isOnline(s);
  return on ? (
    <>
      <span className="full">{addrOf(s)}</span>
      <span className="short">{`:${s.port}`}</span>
    </>
  ) : (
    tail
  );
}

/** role=img + aria-label keeps a bare dot from being invisible to a screen reader; filled disc vs hollow ring still differ without colour. */
function Dot({ kind, word }: { readonly kind: 'on' | 'failed' | 'off'; readonly word: string }) {
  return <span className={`glyph ${kind}`} role="img" aria-label={word} title={word} />;
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
  const open = useCallback((r: string) => send.openServer(id, r), [send, id]);
  const copy = useCallback((r: string) => send.copyServerUrl(id, r), [send, id]);
  const restart = useCallback((r: string) => send.restartServer(id, r), [send, id]);
  const stop = useCallback((r: string) => send.stopServer(id, r), [send, id]);
  const start = useCallback((r: string) => send.startServer(id, r), [send, id]);
  return (
    <tr>
      <td className="c-dot">
        <Dot kind={on ? 'on' : failed ? 'failed' : 'off'} word={status} />
      </td>
      <td className="c-name" title={s.service}>
        {s.service}
      </td>
      <td className={on ? 'c-addr' : 'c-addr off'} title={on ? addrOf(s) : failed ? 'failed to start — see log' : 'offline — no address'}>
        <Address s={s} tail={failed ? 'failed to start' : '—'} />
      </td>
      <td className="c-addrops">
        <span className="g">
          {on ? (
            <>
              <PostAction data-act="open-server" id={id} label="Open in browser" icon="external-link" post={open} />
              <CopyAction data-act="copy-server-url" id={id} label="Copy URL" icon="copy" post={copy} />
            </>
          ) : null}
        </span>
      </td>
      <td className="c-acts">
        <span className="g">
          {on ? (
            <>
              <PostAction data-act="restart-server" id={id} label="Restart" icon="refresh" post={restart} />
              <PostAction data-act="stop-server" id={id} label="Stop" icon="player-stop" post={stop} />
            </>
          ) : (
            <PostAction data-act="start-server" id={id} label="Start service" icon="player-play" post={start} />
          )}
        </span>
      </td>
    </tr>
  );
}, sameRow);

/** A shared row's status, in words: the dot is never the only carrier. */
const sharedWord = (s: SharedServer): string => (s.status === 'running' || s.status === 'failed' || s.status === 'missing' ? s.status : 'stopped');

/**
 * One shared (baseline) row: read-only. Open exists only while it runs; Logs only when it has a file;
 * Manage is always there. No start/stop/restart on purpose: a stop affects every other ticket, so it
 * lives behind the project view's host confirm (UI-R33).
 */
export const SharedRow = memo(function SharedRow({ s, send }: RowProps<SharedServer>) {
  const on = isOnline(s);
  const word = sharedWord(s);
  const fault = s.status === 'failed' || s.status === 'missing';
  const id = s.id;
  const open = useCallback((r: string) => send.openServer(id ?? 0, r), [send, id]);
  const manage = useCallback((r: string) => send.openResources(r), [send]);
  const logs = useOverlays().openLogs;
  return (
    <tr>
      <td className="c-dot">
        <Dot kind={on ? 'on' : fault ? 'failed' : 'off'} word={word} />
      </td>
      <td className="c-name">
        <span className="srvname" title={s.service}>
          {s.service}
        </span>
        <span className="srvmeta">
          {s.baseBranch ? <span className="srvbranch k-chip">{s.baseBranch}</span> : null}
          <span className="srvnote">{s.missingReason ? s.missingReason : s.sharedWith}</span>
        </span>
      </td>
      <td className={on ? 'c-addr' : 'c-addr off'} title={on ? addrOf(s) : `${word} — no address`}>
        {/* An offline shared row reads "—" AND the word, so a user who cannot see the dot's colour still reads the state. */}
        <Address
          s={s}
          tail={
            <>
              {'— '}
              <span className="offword">{word}</span>
            </>
          }
        />
      </td>
      <td className="c-addrops">
        <span className="g">
          {on && id != null ? <PostAction data-act="open-server" id={id} label="Open in browser" icon="external-link" post={open} /> : null}
        </span>
      </td>
      <td className="c-acts">
        <span className="g">
          {s.logPath ? <LocalAction data-act="server-logs-request" label="View server logs" icon="terminal-2" run={logs} /> : null}
          <PostAction data-act="open-resources" label="Manage shared services" icon="settings" post={manage} />
        </span>
      </td>
    </tr>
  );
}, sameRow);

/** One group's caption row: name, count and where its rows run. */
export function GroupHead({ label, count, note }: { readonly label: string; readonly count: number; readonly note: string }) {
  return (
    <tr className="srvgroup">
      <th colSpan={5} scope="colgroup">
        <div className="gwrap">
          <span className="gname">{label}</span>
          <span className="gcount">{count}</span>
          <span className="gnote">{note}</span>
        </div>
      </th>
    </tr>
  );
}
