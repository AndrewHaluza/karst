/**
 * The terminal console surface (xterm "detailed mode"): a full-body swap via `body.term-nav` into the static `#termView`
 * root, exactly like the artifact surface. The overlay stack says which console is open (a gate stage, or one gate-lane AI
 * process of it); this view is mounted only while it is, keyed by that, so closing or switching disposes the Terminal.
 *
 * The one place that hands a DOM node to non-React code: `#termHost` is an element React never reconciles children into
 * (only the refusal blurb is a React child, and it swaps the element itself), the Terminal is created in an effect and
 * disposed in its cleanup. The library is delivered lazily (`xtermLoader.ts`); until it lands, what the host sends is held
 * and written when the Terminal exists.
 *
 * The host's answer to the log request is ALWAYS sent, ok or error, and is the terminal outcome (UI-R13). A live chunk
 * that races it is held and written behind the persisted tail. A refusal (a mid-run console has no artifact yet) replaces
 * the Terminal with a blurb; live output arriving afterwards swaps a fresh Terminal back in.
 */
import { useEffect, useRef, useState } from 'react';
import type { StageLogResult } from '../messages.js';
import { useHostMessage, useOverlay, useOverlays } from './DashboardAppContext.js';
import { fromIsland } from './islands.js';
import { RegionPortal } from './RegionPortal.js';
import { useOverlayRoot } from './useOverlayRoot.js';
import { xtermGlobals, xtermPresent, type XtermTerminal } from './xtermLoader.js';
import './Terminal.css';

const STAGE_TITLE: Readonly<Record<string, string>> = { uat: 'UAT', review: 'Review', fix: 'Fix', scope: 'Scope', impl: 'Implementation', ship: 'Ship', done: 'Done' };
const UNAVAILABLE = 'Console rendering is unavailable in this build.';

/**
 * The terminal's colors resolve the DESIGN TOKENS the host already injected (UI-R04): background and foreground come from
 * the editor's own colors, so their contrast is the theme's contract (UI-R29). The ANSI 16 ramp stays xterm's standard
 * palette. `getComputedStyle` resolves the var(--vscode-*) chains to concrete values inside the webview.
 */
function termTokens() {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const tok = (name: string, fallback: string): string => (cs && cs.getPropertyValue(name).trim()) || fallback;
  return {
    background: tok('--k-bg', '#1e1e1e'),
    foreground: tok('--k-text', '#cccccc'),
    cursor: tok('--k-focus', '#3794ff'),
    selectionBackground: tok('--k-surface-selected', 'rgba(127,127,127,.4)'),
    font: tok('--k-font-mono', 'monospace'),
    size: parseFloat(tok('--k-text-base', '')) || 13,
  };
}

/** Console scrollback is only reachable by wheel otherwise: xterm takes no stdin here (disableStdin), so the keys are free to drive its viewport. */
function scrollByKey(term: XtermTerminal, e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key === 'PageUp') term.scrollPages(-1);
  else if (e.key === 'PageDown') term.scrollPages(1);
  else if (e.key === 'Home') term.scrollToTop();
  else if (e.key === 'End') term.scrollToBottom();
  else return false;
  return true;
}

function Console({ stage, processId }: { readonly stage: string; readonly processId: string | null }) {
  const overlays = useOverlays();
  const xterm = useOverlay((s) => s.xterm);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  // Held until the Terminal exists (the library still arriving) or until the first answer has been written (live chunks).
  const pending = useRef('');
  // What the message handler must read the moment a message lands, not after the next render.
  const waiting = useRef(true);
  const refused = useRef(false);

  const unavailable = refusal === null && (xterm === 'ready' || xterm === 'failed') && !xtermPresent();
  const blurb = refusal ?? (unavailable ? UNAVAILABLE : null);

  /** Written now when the Terminal exists; otherwise held for it, unless the library failed (nothing will ever draw it). */
  const hold = (text: string, atFront: boolean): void => {
    if (termRef.current) termRef.current.write(text);
    else if (overlays.getSnapshot().xterm !== 'failed') pending.current = atFront ? text + pending.current : pending.current + text;
  };
  const flush = (): void => {
    if (termRef.current && pending.current) {
      termRef.current.write(pending.current);
      pending.current = '';
    }
  };

  const answer = (result: StageLogResult): void => {
    waiting.current = false;
    setLoading(false);
    if (result.kind === 'ok') {
      setStatus(result.truncated ? 'Console output truncated' : '');
      hold(result.content, true);
      flush();
    } else {
      setStatus('');
      pending.current = '';
      refused.current = true;
      setRefusal(result.message);
    }
  };

  const chunk = (text: string): void => {
    if (waiting.current) {
      pending.current += text;
      return;
    }
    // The console may be showing a refusal ("no recorded console output"): output has now started, so the blurb gives way to a live terminal.
    if (refused.current) {
      refused.current = false;
      setRefusal(null);
    }
    hold(text, false);
  };

  useHostMessage((m) => {
    if (m.type === 'stage-log' && !processId && m.stage === stage) answer(m.result);
    else if (m.type === 'agent-log' && processId && m.processId === processId) answer(m.result);
    else if (m.type === 'stage-output' && !processId && m.stage === stage) chunk(m.text);
    else if (m.type === 'agent-output' && processId && m.processId === processId) chunk(m.text);
  });

  // Create the Terminal when there is somewhere to draw it, dispose it when there is not (a refusal, a close, the library arriving).
  useEffect(() => {
    const host = hostRef.current;
    const g = xtermGlobals();
    if (blurb !== null || !host || !g.Terminal || !g.FitAddon) return undefined;
    const t = termTokens();
    const term = new g.Terminal({
      convertEol: true, // the artifact log uses bare \n; xterm expects \r\n
      disableStdin: true, // a log viewer, never an input surface
      cursorBlink: false,
      scrollback: 10000, // 1 MiB of output is ~10k+ lines at common widths
      fontFamily: t.font,
      fontSize: t.size,
      theme: { background: t.background, foreground: t.foreground, cursor: t.cursor, selectionBackground: t.selectionBackground },
      allowProposedApi: true, // FitAddon's addon lifecycle
    });
    const fit = new g.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // fit lives on the ADDON, not the terminal — `term.fit` does not exist.
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit.fit()) : null;
    resize?.observe(host);
    termRef.current = term;
    if (pending.current) {
      term.write(pending.current);
      pending.current = '';
    }
    return () => {
      resize?.disconnect();
      try {
        term.dispose();
      } catch {
        /* renderer teardown */
      }
      termRef.current = null;
    };
    // `xterm` is not read here: the library landing is what makes the globals above appear, so it re-runs this.
  }, [blurb, xterm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (termRef.current && !fromIsland(e) && scrollByKey(termRef.current, e)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const title = processId ? (processId === 'tester' ? 'Tester' : 'Review') : (STAGE_TITLE[stage] ?? stage);
  return (
    <>
      <div className="thead">
        <span className="ttitle">{`Console · ${title}`}</span>
        <span className="sp">
          <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-term="close" title="Close the console view" onClick={overlays.closeConsole}>
            Close
          </button>
        </span>
      </div>
      <div className="tstatus" id="tstatus" role="status">
        {loading ? 'Loading console output…' : status}
      </div>
      {/* The element is swapped between a blurb and a terminal host, so xterm never meets React's children. */}
      <div key={blurb === null ? 'terminal' : 'blurb'} id="termHost" className="termhost" ref={hostRef}>
        {blurb === null ? null : <div className="blurb">{blurb}</div>}
      </div>
    </>
  );
}

export function TerminalOverlay() {
  const target = useOverlay((s) => s.console);
  useOverlayRoot('termView', target !== null, 'term-nav');
  return <RegionPortal id="termView">{target ? <Console key={`${target.stage}:${target.processId ?? ''}`} stage={target.stage} processId={target.processId} /> : null}</RegionPortal>;
}
