/**
 * The Doctor panel's whole behaviour, vscode-free (DR-3, DR-4, DR-5, DR-7).
 *
 * Everything that is not VS Code lives here so vitest can drive it: the initial
 * run, the rerun, the fix confirmation (host-side, UI-R33), the busy guard, the
 * loading and error pages, and the single-panel lifecycle. `host.ts` is only
 * the binding: a panel factory, a `runCli`, an `ask.warn` and a clipboard.
 */
import { doctorErrorHtml, doctorLoadingHtml, renderDoctorHtml } from '../../doctor/renderHtml.js';
import type { DoctorCheck, DoctorReport } from '../../doctor/types.js';
import { newNonce } from '../../model/csp.js';
import { plural, reasonText } from '../../model/notifyText.js';

export interface DoctorFlowDeps {
  /** Runs `karst doctor --json`, with `--fix --only <id>` per confirmed id. */
  run(fix: boolean, only?: readonly string[]): Promise<DoctorReport>;
  /** Host-side modal (UI-R33). Resolves true only for the published action. */
  confirm(title: string, items: readonly string[], actionLabel: string): Promise<boolean>;
  /** Writes the finished document into the panel (the host hydrates it first). */
  render(html: string): void;
  /** A panel message: restore the #fix button after a cancel, or confirm a copy. */
  post(message: DoctorPanelMessage): void;
  copy?: (text: string) => void | Promise<void>;
  /** True once the panel is disposed: a late run must never touch it. */
  isDisposed?(): boolean;
  nonce?: () => string;
  now?: () => Date;
}

/** The messages the page script answers. */
export type DoctorPanelMessage = { type: 'fix-cancelled' } | { type: 'copy-done' };

export interface DoctorFlow {
  start(): Promise<void>;
  handleMessage(message: unknown): Promise<void>;
}

/** Only non-ok auto fixes are offered: a fixed or non-auto check has nothing to run. */
function autoFixes(report: DoctorReport | undefined): DoctorCheck[] {
  return (report?.checks ?? []).filter((c) => c.status !== 'ok' && c.fix?.tier === 'auto');
}

export function createDoctorFlow(deps: DoctorFlowDeps): DoctorFlow {
  const nonce = deps.nonce ?? newNonce;
  const now = deps.now ?? (() => new Date());
  let lastReport: DoctorReport | undefined;
  let running = false;
  const closed = (): boolean => deps.isDisposed?.() === true;
  /**
   * A run outlives the panel it started in when the tab closes mid-check, so
   * every write goes through these two: a late render or post is dropped
   * instead of throwing "Webview is disposed" — and the catch below cannot
   * throw a second time while it is already handling the first failure.
   */
  const render = (html: string): void => {
    if (!closed()) deps.render(html);
  };
  const post = (message: DoctorPanelMessage): void => {
    if (!closed()) deps.post(message);
  };

  /** One guarded run: loading page, report, or the error page. */
  async function reload(fix: boolean, only: readonly string[] | undefined, isRerun: boolean): Promise<void> {
    if (running || closed()) return;
    running = true;
    try {
      render(doctorLoadingHtml(nonce()));
      const report = await deps.run(fix, only);
      lastReport = report;
      render(renderDoctorHtml(report, nonce(), { checkedAt: now(), focusTitle: isRerun }));
    } catch (e) {
      render(doctorErrorHtml(reasonText(e), nonce()));
    } finally {
      running = false;
    }
  }

  async function fix(): Promise<void> {
    if (running || closed()) return;
    const targets = autoFixes(lastReport);
    // Nothing listed means nothing to confirm: hand the button back.
    if (targets.length === 0) {
      post({ type: 'fix-cancelled' });
      return;
    }
    running = true;
    try {
      const title = `Apply ${plural(targets.length, 'safe fix', 'safe fixes')}?`;
      const items = targets.map((c) => c.fix!.summary);
      const actionLabel = `Apply ${plural(targets.length, 'fix', 'fixes')}`;
      const ids = targets.map((c) => c.id);
      // A modal that cannot be shown counts as a cancel: the page must get its
      // button back rather than keep it disabled and aria-busy forever.
      const confirmed = await deps.confirm(title, items, actionLabel).catch(() => false);
      // The tab closed while the modal was open: nothing to confirm to, nothing to run.
      if (closed()) return;
      if (!confirmed) {
        post({ type: 'fix-cancelled' });
        return;
      }
      render(doctorLoadingHtml(nonce()));
      try {
        // Pin exactly what the modal listed: `--fix` alone would re-collect and
        // could act on something the user never saw (DR-3).
        const report = await deps.run(true, ids);
        lastReport = report;
        render(renderDoctorHtml(report, nonce(), { checkedAt: now() }));
      } catch (e) {
        render(doctorErrorHtml(reasonText(e), nonce()));
      }
    } finally {
      running = false;
    }
  }

  return {
    start: () => reload(false, undefined, false),
    async handleMessage(message: unknown): Promise<void> {
      if (typeof message !== 'object' || message === null) return;
      const type = (message as { type?: unknown }).type;
      if (type === 'rerun') {
        await reload(false, undefined, true);
        return;
      }
      if (type === 'fix') {
        await fix();
        return;
      }
      if (type === 'copy') {
        const text = (message as { text?: unknown }).text;
        if (typeof text !== 'string' || deps.copy === undefined) return;
        await deps.copy(text);
        // A copy that never reached the clipboard gets no confirmation (UI-R27).
        post({ type: 'copy-done' });
      }
    },
  };
}

/** The minimum a webview panel must expose for the lifecycle below (vscode-free stand-in). */
export interface DoctorPanelLike {
  readonly webview: {
    html: string;
    onDidReceiveMessage(listener: (message: unknown) => void): unknown;
  };
  onDidDispose(listener: () => void): unknown;
  reveal(): void;
  dispose(): void;
}

export interface DoctorPanelControllerDeps<P extends DoctorPanelLike> {
  createPanel(): P;
  /**
   * Prepare a panel before its flow starts: the tab icon and `enableScripts`.
   * A panel VS Code restored from the serializer comes back with scripts OFF,
   * so this must run on the restore path too — skipping it leaves the restored
   * tab with no script and every control dead.
   */
  adopt(panel: P): void;
  createFlow(panel: P, lifecycle: DoctorPanelLifecycle): DoctorFlow;
}

/** What a flow may ask about its panel after an await. */
export interface DoctorPanelLifecycle {
  isDisposed(): boolean;
}

export interface DoctorPanelController<P extends DoctorPanelLike> {
  /** Show the doctor: reuse the open panel (reveal + rerun) or mint one. */
  open(): Promise<void>;
  /** Adopt the panel VS Code restored after a reload; a duplicate is closed. */
  restore(raw: P): Promise<void>;
}

/** One doctor tab, one flow (DR-7). */
export function createDoctorPanelController<P extends DoctorPanelLike>(
  deps: DoctorPanelControllerDeps<P>,
): DoctorPanelController<P> {
  let current: { panel: P; flow: DoctorFlow } | undefined;

  const adopt = (panel: P): DoctorFlow => {
    deps.adopt(panel);
    let disposed = false;
    const flow = deps.createFlow(panel, { isDisposed: () => disposed });
    current = { panel, flow };
    panel.onDidDispose(() => {
      disposed = true;
      if (current?.panel === panel) current = undefined;
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      // A handler that throws must not become an unhandled rejection: the flow
      // already turns a failed run into its error page.
      void flow.handleMessage(message).catch(() => undefined);
    });
    return flow;
  };

  return {
    async open(): Promise<void> {
      if (current) {
        current.panel.reveal();
        await current.flow.handleMessage({ type: 'rerun' });
        return;
      }
      const flow = adopt(deps.createPanel());
      await flow.start();
    },
    async restore(raw: P): Promise<void> {
      if (current) {
        raw.dispose();
        return;
      }
      const flow = adopt(raw);
      await flow.start();
    },
  };
}
