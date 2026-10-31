import { readdir, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { ensureSandboxSetup, type SetupResult, type SetupWindowPort } from '../../agent/sandboxSetup.js';
import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { setupHostsOf } from '../../manifest/sandboxSetupHosts.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import type { Manifest } from '../../manifest/types.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import type { Notify } from './notify.js';

/** What the buttons on a sandbox-setup failure do (arch:AC-47); the host binds them. */
export interface SetupFailureActions {
  /** Forget the recorded setup, run it again, clear the block and re-drive the stage. */
  readonly rerun: (ticketId: number) => Promise<void>;
  readonly openLog: (path: string) => void;
  readonly memoryHelp: () => void;
}

export const RERUN_SETUP = 'Re-run setup';
export const SHOW_SETUP_LOG = 'Show setup log';
export const DOCKER_MEMORY_HELP = 'Docker memory help';
export const DOCKER_MEMORY_HELP_TEXT = 'Setup was likely killed for lack of memory. Raise Docker Desktop → Settings → Resources → Memory (8 GB or more), or wait for other UAT / Playwright runs to finish, then Re-run setup.';

export interface TicketSetupDeps {
  readonly actions?: SetupFailureActions;
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
  /** docker only: memory/container context for a killed (137) setup's reason. */
  readonly killContextOf?: (ticketId: number) => (() => Promise<string | undefined>) | undefined;
  readonly ticketLabel: (ticketId: number) => string;
  readonly notify: Notify;
  readonly debug?: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const CLONE_READY_SH = 'git rev-parse --verify HEAD >/dev/null 2>&1 && [ -n "$(git ls-tree --name-only HEAD | head -n 1)" ]';
/** Any ONE lockfile is enough (an npm-only repo has no yarn.lock). */
export const LOCKFILES_SH = '[ -e package-lock.json ] || [ -e pnpm-lock.yaml ] || [ -e yarn.lock ]';
/** A lockfile-strict install: with no lockfile it fails for a reason that says nothing about the setup. */
const CI_STYLE = /\b(npm\s+ci|(pnpm|yarn)\s+install\s+[^&|;]*--frozen-lockfile|pnpm\s+i\s+[^&|;]*--frozen-lockfile)/;

async function probeOk(runGate: GateProcessRunner, script: string, cwd: string): Promise<boolean> {
  const out = await runGate('sh', ['-c', script], cwd);
  return out.kind === 'completed' && out.exitCode === 0;
}

/** Does every setup-declaring worktree of the ticket hold a checked-out commit with a non-empty tree? */
export async function ticketCloneReady(deps: Pick<TicketSetupDeps, 'manifest' | 'worktrees' | 'gateProcess'>, ticketId: number): Promise<boolean> {
  const manifest = deps.manifest();
  const runGate = deps.gateProcess(ticketId);
  if (!manifest || !runGate) return true;
  for (const wt of deps.worktrees(ticketId)) {
    const def = Object.entries(manifest.repositories).find(([key, r]) => key === wt.repo || r.repoPath === wt.repo)?.[1];
    if (def?.sandbox && !(await probeOk(runGate, CLONE_READY_SH, wt.path))) return false;
  }
  return true;
}

export const MISSING_SETUP_HINT = 'sandbox.setup: npm ci';

/** Repos in the sandbox that carry a lockfile but declare no `sandbox.setup`: their clone has no dependencies (arch:AC-40). Host ticket = none. */
export async function reposMissingSetup(deps: Pick<TicketSetupDeps, 'manifest' | 'worktrees' | 'gateProcess'>, ticketId: number): Promise<string[]> {
  const manifest = deps.manifest();
  const runGate = deps.gateProcess(ticketId);
  if (!manifest || !runGate) return [];
  const missing: string[] = [];
  for (const wt of deps.worktrees(ticketId)) {
    const [name, def] = Object.entries(manifest.repositories).find(([key, r]) => key === wt.repo || r.repoPath === wt.repo) ?? [];
    if (name && def && !def.sandbox?.setup && (await probeOk(runGate, LOCKFILES_SH, wt.path))) missing.push(name);
  }
  return missing;
}

/** Non-blocking launch/reattach warning for `reposMissingSetup`; a failed probe only reaches `debug`. No `warn` seam = no probe. */
export async function warnMissingSetup(
  seam: { readonly warn?: (message: string) => void; readonly debug?: (message: string) => void },
  deps: Pick<TicketSetupDeps, 'manifest' | 'worktrees' | 'gateProcess'>, ticketId: number,
): Promise<void> {
  if (!seam.warn) return;
  try {
    const missing = await reposMissingSetup(deps, ticketId);
    if (missing.length === 1) seam.warn(`Karst: sandbox repo ${missing[0]} has a lockfile but no sandbox.setup, so its clone has no dependencies. Add \`${MISSING_SETUP_HINT}\` to its manifest entry.`);
    else if (missing.length > 1) seam.warn(`Karst: sandbox repos ${missing.join(', ')} have a lockfile but no sandbox.setup, so their clones have no dependencies. Add \`${MISSING_SETUP_HINT}\` to each manifest entry.`);
  } catch (err) {
    seam.debug?.(`[sandbox] ticket ${ticketId}: missing-setup probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Reattach runs after every launch: show each distinct warning once per extension-host session. */
export function onceByMessage(warn: (message: string) => void): (message: string) => void {
  const seen = new Set<string>();
  return (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    warn(message);
  };
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
    // Background only: a ci-style setup with no lockfile saw an unfinished clone. Never record that as `failed`; the pre-gate run decides.
    if (opts.background && CI_STYLE.test(job.setup) && !(await probeOk(runGate, LOCKFILES_SH, job.cwd))) {
      deps.debug?.(`[sandbox] ticket ${ticketId} ${job.name}: no lockfile yet, background setup skipped`);
      return { ok: true };
    }
    // The first repo owns `<id>.setup.json`; further ones get their own file beside it.
    const stateFile = paths ? (i === 0 ? paths.setupStateFile : paths.setupStateFile.replace(/\.setup\.json$/, `.${job.name}.setup.json`)) : undefined;
    if (!stateFile) return { ok: true }; // no bridge dir: nowhere outside the mount to record, so no step
    const result = await ensureSandboxSetup(
      {
        runGate, stateFile, ...(window ? { window } : {}), ...(i === 0 && paths ? { logFile: paths.setupLogFile } : {}),
        ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.killContextOf?.(ticketId) ? { killContext: deps.killContextOf(ticketId)! } : {}), ...(deps.debug ? { debug: deps.debug } : {}),
      },
      { key: `${ticketId}:${job.name}`, setup: job.setup, hosts: job.hosts, cwd: job.cwd, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (!result.ok) {
      deps.debug?.(`[sandbox] ticket ${ticketId} ${job.name}: ${result.reason}`);
      notifyFailure(deps, ticketId, result.reason, paths!.setupLogFile); // stateFile above implies a bridge
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

/** One notification; with an action-capable Notify and bound actions it carries the buttons. */
function notifyFailure(deps: TicketSetupDeps, ticketId: number, reason: string, logFile: string): void {
  const message = `Karst: ${deps.ticketLabel(ticketId)} sandbox setup failed: ${reason}`;
  const { actions } = deps;
  if (!deps.notify.errorActions || !actions) {
    void deps.notify.error(message);
    return;
  }
  const killed = reason.includes('likely out of memory');
  const labels = [RERUN_SETUP, SHOW_SETUP_LOG, ...(killed ? [DOCKER_MEMORY_HELP] : [])];
  void deps.notify.errorActions(message, labels).then(async (choice) => {
    if (choice === RERUN_SETUP) await actions.rerun(ticketId);
    else if (choice === SHOW_SETUP_LOG) actions.openLog(logFile);
    else if (choice === DOCKER_MEMORY_HELP) actions.memoryHelp();
  }).catch((err: unknown) => deps.debug?.(`[sandbox] setup failure action failed: ${err instanceof Error ? err.message : String(err)}`));
}
