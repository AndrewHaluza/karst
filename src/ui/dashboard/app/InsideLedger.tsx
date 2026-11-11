/**
 * The process ledger: one row per process. A process with evidence (or footer facts) is a native <details>, so
 * keyboard operability comes from the element, never a handler (UI-R09); one with nothing behind it is the prototype's
 * `.op-static`, a row that states its fact and offers no disclosure it cannot honour. A delivery receipt is not a
 * disclosure at all: its overview stays visible and only its detail lines sit behind their own inner <details>.
 *
 * The host ships pre-built status, detail, counts, identity and evidence per row; the webview renders them verbatim.
 * The row memoises on a comparison that does not see the ticking facts (clocks, tokens), which the small leaves in
 * `InsideClocks.tsx` read themselves, so the 1 Hz push re-renders none of this.
 */
import { memo, useCallback, type MouseEvent, type SyntheticEvent } from 'react';
import type { InsideProcessView } from '../../../model/inside/types.js';
import { useDashboardSend, useOps, useOverlays, usePendingOps } from './DashboardAppContext.js';
import { beginPending, usePendingAction } from './usePendingAction.js';
import { EvidenceBody } from './EvidenceBody.js';
import { Icon } from './Icon.js';
import { RowDuration, RowTime, RowTokens } from './InsideClocks.js';
import { InsideActionButton, Identity } from './InsideParts.js';
import { useInsideScope } from './InsideMemory.js';
import { hasEvidenceBody, statusWord, withKeys } from './insideText.js';
import { sameIgnoringLive } from './insideLive.js';

const DELIVER_ID = 'deliver';
const RESUME_TITLE = 'Resume — unpause execution';

/** The console (terminal detailed mode) entry point: icon-only, the label moving to aria-label + title (the SAME string, UI-R21/R24). */
export function ConsoleButton({ owner, p }: { readonly owner: string; readonly p: InsideProcessView }) {
  const overlays = useOverlays();
  // The gates row and the Deliver row open the stage's whole console, not one process's.
  const gates = p.id === 'gates' || p.id === DELIVER_ID;
  const label = `View this ${gates ? "stage's" : "process's"} console output in the dashboard`;
  // Reads `owner`, never a selection: a console click must not re-point the strip. A gate-lane AI process narrows the surface to its own console.
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      // Inside a <summary>: without this the click would also toggle the disclosure.
      e.preventDefault();
      overlays.openConsole(owner, gates ? null : p.id);
    },
    [overlays, owner, gates, p.id],
  );
  return (
    <button type="button" className="k-iconbtn ib t-open" data-act="console" data-console={owner} data-console-proc={gates ? undefined : p.id} aria-label={label} title={label} onClick={onClick}>
      <Icon name="terminal-2" />
    </button>
  );
}

interface RowProps {
  readonly p: InsideProcessView;
  readonly stageKey: string;
  /** The stage whose log the GATES row's console opens (the host's `view.console` flag), or null. */
  readonly consoleStage: string | null;
  readonly open: boolean;
}

function Footer({ footer }: { readonly footer: readonly string[] | undefined }) {
  if (!footer || !footer.length) return null;
  return (
    <div className="session-foot">
      {withKeys(footer, (f) => f).map(([key, f], i) => (
        <span key={key} className={i === footer.length - 1 ? 'session-rule' : undefined}>
          {f}
        </span>
      ))}
    </div>
  );
}

/** Inline Resume on a paused stage's row — the pause chip alone was missed (D303). Label 'Resume'; the sentence is the title. */
function UnpauseButton() {
  const send = useDashboardSend();
  const pend = usePendingAction((requestId) => send.unpauseExecution(requestId));
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      // Inside a <summary>: without this the click would also toggle the disclosure.
      e.preventDefault();
      pend(e);
    },
    [pend],
  );
  return (
    <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="unpause-execution" title={RESUME_TITLE} aria-label={RESUME_TITLE} onClick={onClick}>
      <Icon name="player-play" />
      Resume
    </button>
  );
}

/**
 * The Deliver row's Push button: the host syncs the sandbox and pushes, reports through notifications, then sends a state
 * push. The request carries no id on the wire, so it is held in `pendingOps` and settles on that push (a second click
 * cannot start a second delivery). The title (= aria-label) is the host's sentence and starts with the label.
 */
function DeliverPushButton({ title }: { readonly title: string }) {
  const send = useDashboardSend();
  const ops = usePendingOps();
  const busy = useOps().running.has('deliver');
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      // Inside a <summary>: without this the click would also toggle the disclosure.
      e.preventDefault();
      if (ops.isRunning('deliver')) return;
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginAction('deliver', requestId);
      send.deliverToPr();
    },
    [ops, send],
  );
  return (
    <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="deliver-to-pr" aria-busy={busy ? 'true' : undefined} disabled={busy} title={title} aria-label={title} onClick={onClick}>
      <Icon name="git-branch" />
      Push
    </button>
  );
}

const ProcessRow = memo(
  function ProcessRow({ p, stageKey, consoleStage, open }: RowProps) {
    const { memory } = useInsideScope();
    const key = `${stageKey}:${p.id}`;
    // The native `toggle` also fires when React sets `open` itself (an auto-open of a running row): that is not a user
    // choice. Record it only when the user already has a verdict on this row, or the DOM differs from what React set.
    const onToggle = useCallback(
      (e: SyntheticEvent<HTMLDetailsElement>) => {
        const isOpen = e.currentTarget.open;
        if (memory.explicit(key) !== null || isOpen !== open) memory.toggled(key, isOpen);
      },
      [memory, key, open],
    );
    const running = p.id === 'autofix' && p.status === 'run';
    const glyph = <span className={`glyph ${p.status}`} role="img" aria-label={p.statusLabel || statusWord(p.status)} />;
    const name = (
      <span className="op-name" title={p.label}>
        <span className="op-name-text">{p.label}</span>
        {p.execution || p.configuredExecution || p.aiMark ? <span className="ai-mark">AI</span> : null}
      </span>
    );
    // A gate-lane AI process offers the same console from its OWN description area when the host flags `p.console` (a
    // run happened and a tail exists): that is the process's own availability and does not depend on the stage's.
    const owner = p.id === 'gates' ? consoleStage : p.console ? stageKey || consoleStage : null;
    const detail = (
      <span className={`op-detail ${p.status}${owner ? ' detail-console' : ''}`} role={p.id === DELIVER_ID ? 'status' : undefined}>
        {p.detail ? <span className="op-detail-text">{p.detail}</span> : null}
        {owner ? <ConsoleButton owner={owner} p={p} /> : null}
        {p.paused ? <UnpauseButton /> : null}
      </span>
    );
    // No status WORD in the tail: the row carries its state on the glyph (which keeps the word as its accessible name).
    const tail = (
      <span className="op-tail">
        <Identity p={p} />
        {p.aggregate ? (
          <span className="count" title={p.aggregateTitle || undefined}>
            {p.aggregate}
          </span>
        ) : null}
        {p.count ? <span className="count">{p.count}</span> : null}
        {p.action ? <InsideActionButton action={p.action} /> : null}
        {p.deliver ? <DeliverPushButton title={p.deliver.title} /> : null}
        {/* The Σ pill is the LAST tail item, so it sits directly before the time columns and in the timeline rows' Σ column (UI-R41). */}
        <RowTokens stage={stageKey} id={p.id} />
      </span>
    );
    // The timing is two grid cells of the row, after the action: fixed columns, so the rows line up (UI-R41).
    const timing = (
      <>
        <RowTime stage={stageKey} id={p.id} />
        <RowDuration stage={stageKey} id={p.id} />
      </>
    );
    const ev = p.evidence;
    const footer = <Footer footer={p.footer} />;

    if (ev && ev.kind === 'receipt') {
      const body = (
        <div className="op-body receipt-body" data-proc-id={key}>
          <EvidenceBody ev={ev} p={p} stageKey={stageKey} />
          {footer}
        </div>
      );
      // A receipt with a hero already states the delivery in the green banner; its summary would say the same thing twice, so the body alone is the row.
      if (ev.hero) return body;
      return (
        <>
          <div className="op op-static" data-proc-id={key}>
            {glyph}
            {name}
            {detail}
            {tail}
            {timing}
            <span />
          </div>
          {body}
        </>
      );
    }

    const hasFooter = !!(p.footer && p.footer.length);
    if (!hasEvidenceBody(ev) && !hasFooter) {
      return (
        <div className="op">
          <div className="op-static" data-proc-id={key} aria-busy={running || undefined}>
            {glyph}
            {name}
            {detail}
            {tail}
            {timing}
            <span />
          </div>
        </div>
      );
    }
    const cls = `op ${p.status}${p.status === 'run' ? ' live' : ''}${p.status === 'fail' ? ' failed-source' : p.status === 'wait' ? ' waiting-source' : ''}`;
    // The body is ALWAYS in the markup. <details> is what shows and hides it: rendering it only when open meant the
    // first click expanded an empty disclosure.
    return (
      <details className={cls} data-proc-id={key} open={open} onToggle={onToggle} aria-busy={running || undefined}>
        <summary>
          {glyph}
          {name}
          {detail}
          {tail}
          {timing}
          <span className="chev" aria-hidden="true" />
        </summary>
        <div className="op-body">
          {ev && hasEvidenceBody(ev) ? <EvidenceBody ev={ev} p={p} stageKey={stageKey} /> : null}
          {footer}
        </div>
      </details>
    );
  },
  (a, b) => a.stageKey === b.stageKey && a.consoleStage === b.consoleStage && a.open === b.open && sameIgnoringLive(a.p, b.p),
);

/** Which process kinds render OPEN on the FIRST render: the session's own timeline is the approval screenshot's starting state. */
const DEFAULT_OPEN_KINDS: ReadonlySet<string> = new Set(['session']);

export function Ledger({ stageKey, processes, consoleStage }: { readonly stageKey: string; readonly processes: readonly InsideProcessView[]; readonly consoleStage: string | null }) {
  const { memory } = useInsideScope();
  return (
    <div className="ledger">
      {processes.map((p) => {
        const key = `${stageKey}:${p.id}`;
        // The user's own toggle wins once touched; else the default-open kinds. A RUNNING process opens itself: its body is the
        // only place the work becomes visible (gate rows land one at a time as each finishes).
        const hasBody = hasEvidenceBody(p.evidence) || !!(p.footer && p.footer.length);
        const open = memory.explicit(key) ?? (hasBody && (DEFAULT_OPEN_KINDS.has(p.kind) || p.status === 'run'));
        return <ProcessRow key={key} p={p} stageKey={stageKey} consoleStage={consoleStage} open={open} />;
      })}
    </div>
  );
}
