import { readdir, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { ensureSandboxSetup, type SetupResult, type SetupWindowPort } from '../../agent/sandboxSetup.js';
import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { setupHostsOf } from '../../manifest/sandboxSetupHosts.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import type { Manifest } from '../../manifest/types.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import type { Notify } from './notify.js';

export interface TicketSetupDeps {
  readonly manifest: () => Manifest | undefined;
  /** The ticket's worktrees: `repo` is the manifest key or its repoPath. */
  readonly worktrees: (ticketId: number) => readonly { readonly repo: string; readonly path: string }[];
  /** The ticket's sandbox gate runner, or undefined for a host ticket. */
  readonly gateProcess: (ticketId: number) => GateProcessRunner | undefined;
  readonly bridgeOf: (ticketId: number) => BridgePaths | undefined;
  /** The ticket's sandbox runner: where the setup network window opens and closes. */
  readonly windowOf?: (ticketId: number) => Pick<SessionRunner, 'setupWindow' | 'windowNeedsIdle'> | undefined;
  /** Is an agent turn live? docker's window recreates the proxy, so it waits for idle. */
  readonly turnActive?: (ticketId: number) => boolean;
  readonly ticketLabel: (ticketId: number) => string;
  readonly notify: Notify;
  readonly debug?: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Run each declared `sandbox.setup` of the ticket's repositories inside its sandbox
 * (arch:AC-36), in order; the first failure stops. A host ticket, or one whose repos declare
 * no setup, is `ok` untouched. The refusal is notified ONCE here, so callers only log it.
 */
export async function provisionTicketSandbox(deps: TicketSetupDeps, ticketId: number, opts: { readonly signal?: AbortSignal; readonly background?: boolean } = {}): Promise<SetupResult> {
  const manifest = deps.manifest();
  const runGate = deps.gateProcess(ticketId);
  const paths = deps.bridgeOf(ticketId);
  if (!manifest || !runGate) return { ok: true };
  const runner = deps.windowOf?.(ticketId);
  // A docker window recreates the proxy: not at create (an agent session is coming up), the first pre-gate check runs it.
  if (opts.background && runner?.windowNeedsIdle) return { ok: true };
  const open = runner?.setupWindow?.bind(runner);
  const window: SetupWindowPort | undefined = open
    ? { open, needsIdle: runner?.windowNeedsIdle === true, turnActive: () => deps.turnActive?.(ticketId) === true }
    : undefined;
  const todo = deps.worktrees(ticketId).flatMap((wt) => {
    const [name, def] = Object.entries(manifest.repositories).find(([key, r]) => key === wt.repo || r.repoPath === wt.repo) ?? [];
    return name && def?.sandbox ? [{ name, setup: def.sandbox.setup, hosts: setupHostsOf(def.sandbox.setupHosts), cwd: wt.path }] : [];
  });
  for (const [i, job] of todo.entries()) {
    // The first repo owns `<id>.setup.json`; further ones get their own file beside it.
    const stateFile = paths ? (i === 0 ? paths.setupStateFile : paths.setupStateFile.replace(/\.setup\.json$/, `.${job.name}.setup.json`)) : undefined;
    if (!stateFile) return { ok: true }; // no bridge dir: nowhere outside the mount to record, so no step
    const result = await ensureSandboxSetup(
      {
        runGate, stateFile, ...(window ? { window } : {}), ...(i === 0 && paths ? { logFile: paths.setupLogFile } : {}),
        ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.debug ? { debug: deps.debug } : {}),
      },
      { key: `${ticketId}:${job.name}`, setup: job.setup, hosts: job.hosts, cwd: job.cwd, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (!result.ok) {
      deps.debug?.(`[sandbox] ticket ${ticketId} ${job.name}: ${result.reason}`);
      void deps.notify.error(`Karst: ${deps.ticketLabel(ticketId)} sandbox setup failed: ${result.reason}`);
      return result;
    }
  }
  return { ok: true };
}

/** Forget every recorded setup of a ticket (`<id>.setup.json`, `<id>.<repo>.setup.json`) so the next run starts afresh. */
export async function clearSetupState(paths: BridgePaths): Promise<void> {
  const dir = dirname(paths.setupStateFile);
  const own = basename(paths.setupStateFile).replace(/\.setup\.json$/, '');
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.filter((n) => n.endsWith('.setup.json') && (n === `${own}.setup.json` || n.startsWith(`${own}.`))).map((n) => rm(`${dir}/${n}`, { force: true })));
}
