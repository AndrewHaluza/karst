import { homedir } from 'node:os';
import { accountReaderEnv, activeAccountLabel } from '../accounts/registry.js';
import { DEFAULT_ACCOUNT } from '../accounts/types.js';
import type { AgentProvider } from '../../manifest/types.js';
import { codexQuotaReader } from './codex.js';
import { claudeQuotaReader } from './claude.js';
import { opencodeQuotaReader } from './opencode.js';
import { antigravityQuotaReader } from './antigravity.js';
import type { ProcessLister } from './antigravityDiscovery.js';
import type { QuotaReader, QuotaSnapshot } from './types.js';

/**
 * The QuotaSnapshot service: one reader per core, cached in memory, refreshed
 * on a modest interval and on demand.
 *
 * Reads are LOCAL (a session JSONL tail, a cached statusline payload) or a
 * provider usage API that spends no model request (OpenCode Go), and every read
 * is ASYNC, so a refresh never blocks the extension host's event loop
 * (activation, the 5-minute poll, and an on-demand refresh all stay
 * non-blocking). The launch path reads the CACHE synchronously rather than
 * waiting on a read. That is what "never blocks launch" means here.
 *
 * Nothing is persisted: snapshots live for the window's lifetime only. No
 * reader sees or logs a token (`arch:AC-29` redaction rule).
 */

/** Modest poll interval — the provider only updates these on its own turns. */
export const DEFAULT_QUOTA_POLL_MS = 5 * 60_000;

export interface QuotaServiceDeps {
  readers: QuotaReader[];
  /** Injected clock — the snapshots' `readAt` and the "read Xm ago" age. */
  now?: () => Date;
  pollMs?: number;
  debug?: (message: string) => void;
  /** Called after every refresh that produced snapshots. */
  onDidChange?: (snapshots: QuotaSnapshot[]) => void;
}

/** Cache key: one snapshot per core AND account (`default` = no override, @arch:AC-48). */
function cacheKey(core: AgentProvider, account: string | undefined): string {
  return `${core}:${account ?? DEFAULT_ACCOUNT}`;
}

export class QuotaService {
  private readonly byKey = new Map<string, QuotaSnapshot>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<QuotaSnapshot[]> | undefined;
  private again = false;

  constructor(private readonly deps: QuotaServiceDeps) {}

  /**
   * Cached snapshots of the ACTIVE account of each core, in reader order. Never
   * reads — safe on any path. A core whose active account has no read yet shows
   * `unknown`, never the snapshot of another account.
   */
  snapshots(): QuotaSnapshot[] {
    return this.deps.readers
      .map((reader) => this.get(reader.core))
      .filter((snapshot): snapshot is QuotaSnapshot => snapshot !== undefined);
  }

  /** One core's cached snapshot for its active account, or undefined before the first refresh. */
  get(core: AgentProvider): QuotaSnapshot | undefined {
    const target = core === 'opencode2' && !this.hasReader(core) ? 'opencode' : core;
    const account = activeAccountLabel(target);
    const cached = this.getFor(target, account);
    if (cached !== undefined || account === undefined) return cached;
    return { core: target, state: 'unknown', reason: `reading quota for account ${account}…` };
  }

  /** The cached snapshot of one named account (a launch under a recorded account). */
  getFor(core: AgentProvider, account: string | undefined): QuotaSnapshot | undefined {
    const target = core === 'opencode2' && !this.hasReader(core) ? 'opencode' : core;
    return this.byKey.get(cacheKey(target, account));
  }

  private hasReader(core: AgentProvider): boolean {
    return this.deps.readers.some((reader) => reader.core === core);
  }

  /**
   * Read every core NOW and cache by account. Calls that arrive while a pass
   * runs share it and queue ONE more pass. A reader that throws is reported as
   * that core's `unknown`. A read that ended under another active account is
   * dropped and read again. Async: never blocks the host.
   */
  refresh(): Promise<QuotaSnapshot[]> {
    if (this.running !== undefined) {
      this.again = true;
      return this.running;
    }
    this.running = this.runPasses().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runPasses(): Promise<QuotaSnapshot[]> {
    do {
      this.again = false;
      await this.readAll();
    } while (this.again);
    const snapshots = this.snapshots();
    this.deps.onDidChange?.(snapshots);
    return snapshots;
  }

  private async readAll(): Promise<void> {
    for (const reader of this.deps.readers) {
      const account = activeAccountLabel(reader.core);
      this.deps.debug?.(`karst: quota read core=${reader.core} account=${account ?? DEFAULT_ACCOUNT}`);
      let snapshot: QuotaSnapshot;
      try {
        snapshot = await reader.read();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        snapshot = { core: reader.core, state: 'unknown', reason: `read failed: ${message}` };
        this.deps.debug?.(`karst: quota read failed for ${reader.core}: ${message}`);
      }
      if (activeAccountLabel(reader.core) !== account) {
        this.again = true;
        continue;
      }
      this.byKey.set(cacheKey(reader.core, account), snapshot);
    }
  }

  /** Begin polling. Idempotent. Kicks one refresh off, unawaited. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.deps.pollMs ?? DEFAULT_QUOTA_POLL_MS);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * The core set karst reads quota for, in display order: the cores with a reader
 * first, then the unsupported ones so every core still gets a row.
 */
export const DEFAULT_QUOTA_CORES: readonly AgentProvider[] = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
];

export const QUOTA_CORES = DEFAULT_QUOTA_CORES;

export interface DefaultQuotaReadersDeps {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * Live consent for the OPT-IN Claude OAuth usage API fallback (D185). Absent
   * means OFF, the default; the closure is re-read on every poll, so a Settings
   * toggle reaches the reader without a reload.
   */
  claudeOauthUsageApi?: () => boolean;
  /** Debug sink for the reader lines (the folder only, never a token). */
  debug?: (message: string) => void;
  /** Test seams for the API fallback (production uses the platform defaults). */
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  /** Defaults to `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`. */
  opencodeAuthPath?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected antigravity appDataDir override for tests. */
  antigravityAppDataDir?: string;
  /** Injected for tests so discovery never probes a language server running on the host. */
  antigravityListProcesses?: ProcessLister;
}

/** The production reader set — one reader per core (D162/D201). */
export function defaultQuotaReaders(deps: DefaultQuotaReadersDeps = {}): QuotaReader[] {
  const homeDir = deps.homeDir ?? homedir();
  // Default the reader env to the PROCESS env: the Claude reader honors
  // `CLAUDE_CONFIG_DIR`, and an operator who sets it (the reason the override
  // exists) would otherwise read `~/.claude` and see Claude permanently
  // unknown. An injected `env` still wins for tests.
  const env = deps.env ?? accountReaderEnv();
  const now = deps.now ?? (() => new Date());
  return [
    claudeQuotaReader({
      homeDir,
      env,
      now,
      ...(deps.debug ? { debug: deps.debug } : {}),
      usageApi: {
        enabled: () => deps.claudeOauthUsageApi?.() === true,
        fetchFn: deps.fetchFn,
        platform: deps.platform,
      },
    }),
    codexQuotaReader({ homeDir, env, now }),
    antigravityQuotaReader({
      homeDir,
      env,
      now,
      fetchImpl: deps.fetchImpl,
      appDataDir: deps.antigravityAppDataDir,
      listProcesses: deps.antigravityListProcesses,
    }),
    opencodeQuotaReader({
      core: 'opencode',
      // @arch:AC-55: no injected path → the reader derives it from `env` at every read, so a setActive reaches it.
      ...(deps.opencodeAuthPath !== undefined ? { authPath: deps.opencodeAuthPath } : {}),
      fetchImpl: deps.fetchImpl,
      now,
      env,
      homeDir,
    }),
  ];
}
