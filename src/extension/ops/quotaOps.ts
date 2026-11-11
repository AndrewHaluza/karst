import type { AgentProvider, Manifest } from '../../manifest/types.js';
import { join } from 'node:path';
import { accountReaderEnv, claudeAccountConfigDirs } from '../../agent/accounts/registry.js';
import { buildQuotaIndicator } from '../../ui/quotaStatus.js';
import { quotaLaunchWarning } from '../../agent/quota/warn.js';
import { DEFAULT_QUOTA_WARN_THRESHOLD_PCT } from '../../manifest/validate/quota.js';
import type { QuotaService } from '../../agent/quota/service.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';
import { claudeConfigDir } from '../../agent/quota/claude.js';
import {
  applyClaudeGlobalStatusline,
  type GlobalStatuslineOutcome,
  type InstallGlobalStatuslineOptions,
} from '../../agent/quota/claudeGlobalStatusline.js';
import { resolveNodeExecutable } from '../../agent/nodeExecutable.js';

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
  service: Pick<QuotaService, 'snapshots' | 'get' | 'getFor' | 'refresh'>;
  /** The manifest's warn threshold; `undefined` = the loader default (80). */
  thresholdPct: () => number | undefined;
  coreLabel: (core: AgentProvider) => string;
  /** Active account name of a core when not 'default'; the badge shows it. */
  accountOf?: (core: AgentProvider) => string | undefined;
  status: QuotaStatusSink;
  /** The non-blocking warning seam (`vscode.window.showWarningMessage`). */
  notify: (message: string) => void;
  /** Injected clock — an expired window must not drive the badge or the warning. */
  now?: () => Date;
}

/** Quiet time before an account change refreshes: a burst of watch events gives one refresh. */
export const ACCOUNT_CHANGE_DEBOUNCE_MS = 500;

export class QuotaOps {
  private readonly syncGlobalStatuslineNow: () => void;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: QuotaOpsDeps,
    globalStatusline: ClaudeGlobalStatuslineSyncDeps,
  ) {
    this.syncGlobalStatuslineNow = makeClaudeGlobalStatuslineSync(globalStatusline);
    this.globalError = globalStatusline.error;
  }

  private readonly globalError: (message: string, cause: unknown) => void;

  /**
   * Apply the opt-in GLOBAL Claude statusline install (D184): ON installs or
   * refreshes, OFF restores the operator's entry. Idempotent, so the manifest
   * reload and activation bindings can call it on every pass.
   */
  syncClaudeGlobalStatusline(): void {
    this.syncGlobalStatuslineNow();
  }

  /**
   * The accounts config changed (a switch here or in another window): re-read
   * the quota of the new active account and move the global statusline to its
   * folder. Debounced; `QuotaService.refresh()` never runs twice at once.
   */
  accountsChanged(): void {
    if (this.changeTimer !== undefined) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.deps.service.refresh().catch((error) => this.globalError('karst: quota refresh after an account change failed', error));
      this.syncGlobalStatuslineNow();
    }, ACCOUNT_CHANGE_DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.changeTimer !== undefined) clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
  }

  private threshold(): number {
    return this.deps.thresholdPct() ?? DEFAULT_QUOTA_WARN_THRESHOLD_PCT;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Push the status badge from the given (or freshly cached) snapshots. */
  applyStatus(snapshots?: readonly QuotaSnapshot[]): void {
    const indicator = buildQuotaIndicator(
      snapshots ?? this.deps.service.snapshots(),
      this.threshold(),
      this.deps.coreLabel,
      this.now(),
      this.deps.accountOf,
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
   * `account` is the account of the LAUNCH (the recorded one on a resume): its
   * cached snapshot is used, never the active account's. No snapshot, no warning.
   */
  warnBeforeLaunch(provider: AgentProvider, account?: string): void {
    const snapshot = account === undefined ? this.deps.service.get(provider) : this.deps.service.getFor(provider, account);
    const message = quotaLaunchWarning(
      snapshot,
      this.threshold(),
      this.deps.coreLabel(provider),
      this.now(),
    );
    if (message) this.deps.notify(message);
  }
}

/** The deps the global-statusline sync needs from the extension host. */
export interface ClaudeGlobalStatuslineSyncDeps {
  /** The live manifest; `undefined` (absent/invalid) leaves the file untouched. */
  readonly manifest: () => Manifest | undefined;
  /** `context.globalStorageUri.fsPath` — the wrapper lives OUTSIDE `~/.claude`. */
  readonly storageRoot: string;
  readonly warn: (message: string) => void;
  readonly info: (message: string) => void;
  readonly error: (message: string, cause: unknown) => void;
  /** Test seams (the real functions by default). */
  readonly apply?: (
    opts: InstallGlobalStatuslineOptions & { readonly enabled: boolean },
  ) => GlobalStatuslineOutcome;
  readonly node?: () => string;
  /** Every Claude config folder to restore when the option is OFF (default: all accounts). */
  readonly configDirs?: () => readonly string[];
}

/**
 * The opt-in GLOBAL Claude statusline install (D184, `arch:AC-48`). ON
 * installs/refreshes the wrapper in the operator's settings; OFF restores the
 * backed-up entry. Idempotent, so it rides every manifest reload (activation,
 * Settings save, the external file watcher) and writes nothing when the file
 * already matches. A refused/unreadable settings file is a logged warning,
 * never an activation failure.
 */
export function makeClaudeGlobalStatuslineSync(
  deps: ClaudeGlobalStatuslineSyncDeps,
): () => void {
  const apply = deps.apply ?? applyClaudeGlobalStatusline;
  const node = deps.node ?? resolveNodeExecutable;
  return () => {
    try {
      const manifest = deps.manifest();
      // No usable manifest: leave the operator's global settings alone rather
      // than reading an invalid/absent file as OFF.
      if (manifest === undefined) return;
      const enabled = manifest.quota?.claudeGlobalStatusline === true;
      // ON: the wrapper goes into the folder of the ACTIVE account; earlier accounts keep theirs
      // (it writes only its own folder's cache). OFF: restore every account, each from its own backup.
      const dirs = enabled ? [claudeConfigDir(accountReaderEnv())] : [...(deps.configDirs?.() ?? claudeAccountConfigDirs())];
      for (const configDir of dirs) {
        const outcome = apply({
          enabled,
          configDir,
          wrapperDir: join(deps.storageRoot, 'claude-statusline'),
          node: node(),
        });
        if (outcome.refused !== undefined) {
          deps.warn(
            `karst: Claude global statusline ${
              outcome.refused === 'unreadable' ? 'settings are unreadable' : 'settings are not valid JSON'
            } — left untouched`,
          );
          continue;
        }
        if (outcome.changed) {
          deps.info(`karst: Claude global statusline ${outcome.installed ? 'installed' : 'restored'}`);
        }
      }
    } catch (error) {
      deps.error('karst: Claude global statusline sync failed', error);
    }
  };
}
