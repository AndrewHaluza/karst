import type { AgentProvider } from '../../manifest/types.js';
import { buildQuotaIndicator } from '../../ui/quotaStatus.js';
import { quotaLaunchWarning } from '../../agent/quota/warn.js';
import { DEFAULT_QUOTA_WARN_THRESHOLD_PCT } from '../../manifest/validate/quota.js';
import type { QuotaService } from '../../agent/quota/service.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';

/**
 * The host-agnostic half of the per-core quota wiring (D163).
 *
 * Everything here is a decision — which badge text, whether it is amber,
 * whether a launch warns — so it is unit-testable and lives outside the
 * `vscode` binding. `extension.ts` owns only the two seams the ops layer cannot:
 * the status-bar item itself and `window.showWarningMessage`.
 */

/** The status-bar sink the binding implements over one `vscode.StatusBarItem`. */
export interface QuotaStatusSink {
  set(text: string, tooltip: string, warning: boolean): void;
  hide(): void;
}

export interface QuotaOpsDeps {
  service: Pick<QuotaService, 'snapshots' | 'get'>;
  /** The manifest's warn threshold; `undefined` = the loader default (80). */
  thresholdPct: () => number | undefined;
  coreLabel: (core: AgentProvider) => string;
  status: QuotaStatusSink;
  /** The non-blocking warning seam (`vscode.window.showWarningMessage`). */
  notify: (message: string) => void;
}

export class QuotaOps {
  constructor(private readonly deps: QuotaOpsDeps) {}

  private threshold(): number {
    return this.deps.thresholdPct() ?? DEFAULT_QUOTA_WARN_THRESHOLD_PCT;
  }

  /** Push the status badge from the given (or freshly cached) snapshots. */
  applyStatus(snapshots?: readonly QuotaSnapshot[]): void {
    const indicator = buildQuotaIndicator(
      snapshots ?? this.deps.service.snapshots(),
      this.threshold(),
      this.deps.coreLabel,
    );
    if (!indicator) {
      this.deps.status.hide();
      return;
    }
    this.deps.status.set(indicator.text, indicator.tooltip, indicator.warning);
  }

  /**
   * Warn (and proceed) when the launch's resolved core is at/above the
   * threshold. An unknown core never warns — there is nothing measured.
   */
  warnBeforeLaunch(provider: AgentProvider): void {
    const message = quotaLaunchWarning(
      this.deps.service.get(provider),
      this.threshold(),
      this.deps.coreLabel(provider),
    );
    if (message) this.deps.notify(message);
  }
}
