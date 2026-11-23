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
  /** Restores the #fix button after a cancel. */
  post(message: { type: 'fix-cancelled' }): void;
  copy?: (text: string) => void | Promise<void>;
  nonce?: () => string;
  now?: () => Date;
}

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

  /** One guarded run: loading page, report, or the error page. */
  async function reload(fix: boolean, only: readonly string[] | undefined, isRerun: boolean): Promise<void> {
    if (running) return;
    running = true;
    try {
      deps.render(doctorLoadingHtml(nonce()));
      const report = await deps.run(fix, only);
      lastReport = report;
      deps.render(renderDoctorHtml(report, nonce(), { checkedAt: now(), focusTitle: isRerun }));
    } catch (e) {
      deps.render(doctorErrorHtml(reasonText(e), nonce()));
    } finally {
      running = false;
    }
  }

  async function fix(): Promise<void> {
    if (running) return;
    const targets = autoFixes(lastReport);
    // Nothing listed means nothing to confirm: hand the button back.
    if (targets.length === 0) {
      deps.post({ type: 'fix-cancelled' });
      return;
    }
    running = true;
    try {
      const title = `Apply ${plural(targets.length, 'safe fix', 'safe fixes')}?`;
      const items = targets.map((c) => c.fix!.summary);
      const actionLabel = `Apply ${plural(targets.length, 'fix', 'fixes')}`;
      const ids = targets.map((c) => c.id);
      const confirmed = await deps.confirm(title, items, actionLabel);
      if (!confirmed) {
        deps.post({ type: 'fix-cancelled' });
        return;
      }
      deps.render(doctorLoadingHtml(nonce()));
      try {
        // Pin exactly what the modal listed: `--fix` alone would re-collect and
        // could act on something the user never saw (DR-3).
        const report = await deps.run(true, ids);
        lastReport = report;
        deps.render(renderDoctorHtml(report, nonce(), { checkedAt: now() }));
      } catch (e) {
        deps.render(doctorErrorHtml(reasonText(e), nonce()));
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
        if (typeof text === 'string') await deps.copy?.(text);
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
  createFlow(panel: P): DoctorFlow;
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
    const flow = deps.createFlow(panel);
    current = { panel, flow };
    panel.onDidDispose(() => {
      if (current?.panel === panel) current = undefined;
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void flow.handleMessage(message);
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
