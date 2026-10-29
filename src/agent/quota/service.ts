import { homedir } from 'node:os';
import type { AgentProvider } from '../../manifest/types.js';
import { codexQuotaReader } from './codex.js';
import { claudeQuotaReader } from './claude.js';
import { opencodeAuthPath, opencodeQuotaReader } from './opencode.js';
import { antigravityQuotaReader } from './antigravity.js';
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

export class QuotaService {
  private readonly byCore = new Map<AgentProvider, QuotaSnapshot>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: QuotaServiceDeps) {}

  /** Cached snapshots, in reader order. Never reads — safe on any path. */
  snapshots(): QuotaSnapshot[] {
    return this.deps.readers
      .map((reader) => this.byCore.get(reader.core))
      .filter((snapshot): snapshot is QuotaSnapshot => snapshot !== undefined);
  }

  /** One core's cached snapshot, or undefined before the first refresh. */
  get(core: AgentProvider): QuotaSnapshot | undefined {
    return this.byCore.get(core);
  }

  /**
   * Read every core NOW and replace the cache. A reader that throws is reported
   * as that core's `unknown` — one broken reader must not blank the others.
   * Async: every read is async file I/O, so this never blocks the host.
   */
  async refresh(): Promise<QuotaSnapshot[]> {
    for (const reader of this.deps.readers) {
      let snapshot: QuotaSnapshot;
      try {
        snapshot = await reader.read();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        snapshot = { core: reader.core, state: 'unknown', reason: `read failed: ${message}` };
        this.deps.debug?.(`karst: quota read failed for ${reader.core}: ${message}`);
      }
      this.byCore.set(reader.core, snapshot);
    }
    const snapshots = this.snapshots();
    this.deps.onDidChange?.(snapshots);
    return snapshots;
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
export const QUOTA_CORES: readonly AgentProvider[] = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'opencode2',
];

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
  /** Test seams for the API fallback (production uses the platform defaults). */
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  /** Both default to `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`. */
  opencodeAuthPath?: string;
  opencode2AuthPath?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected antigravity appDataDir override for tests. */
  antigravityAppDataDir?: string;
}

/** The production reader set — one reader per core (D162/D201). */
export function defaultQuotaReaders(deps: DefaultQuotaReadersDeps = {}): QuotaReader[] {
  const homeDir = deps.homeDir ?? homedir();
  // Default the reader env to the PROCESS env: the Claude reader honors
  // `CLAUDE_CONFIG_DIR`, and an operator who sets it (the reason the override
  // exists) would otherwise read `~/.claude` and see Claude permanently
  // unknown. An injected `env` still wins for tests.
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const opencodeAuth = deps.opencodeAuthPath ?? opencodeAuthPath(env, homeDir);
  // opencode2's real path is karst's isolated store, which only the host can
  // resolve (`<globalStorage>/opencode2/data/opencode/auth.json`, AC-27); the
  // default here keeps the reader usable without a host binding.
  const opencode2Auth = deps.opencode2AuthPath ?? opencodeAuthPath(env, homeDir);
  return [
    claudeQuotaReader({
      homeDir,
      env,
      now,
      usageApi: {
        enabled: () => deps.claudeOauthUsageApi?.() === true,
        ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
        ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      },
    }),
    codexQuotaReader({ homeDir, env, now }),
    antigravityQuotaReader({
      homeDir,
      env,
      now,
      fetchImpl: deps.fetchImpl,
      ...(deps.antigravityAppDataDir !== undefined ? { appDataDir: deps.antigravityAppDataDir } : {}),
    }),
    opencodeQuotaReader({
      core: 'opencode',
      authPath: opencodeAuth,
      fetchImpl: deps.fetchImpl,
      now,
      env,
    }),
    opencodeQuotaReader({
      core: 'opencode2',
      authPath: opencode2Auth,
      fetchImpl: deps.fetchImpl,
      now,
      env,
    }),
  ];
}
