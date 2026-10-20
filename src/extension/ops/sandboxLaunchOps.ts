import type { MarkerStage } from '../../agent/markerStage.js';
import { NOT_IN_SANDBOX, renderSandboxMarkerInstruction, scrubHostCli } from '../../agent/sandboxInstructions.js';
import { assertNoSandboxResumeOnHost, SandboxResumeOnHostError } from '../../agent/sandboxResumeGuard.js';
import { renderDoneMarkerInstruction, renderGateOnlyInstruction } from '../../agent/workflowCommand.js';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import { listAttachments } from '../../store/attachments.js';
import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { isMirrorName, mirrorFile, MIRROR_KEEP_LOGS, pruneMirror, pruneOldLogs } from '../../agent/bridge/mirror.js';
import type { LaunchBackend } from './sandboxSyncOps.js';

/**
 * The sandbox-specific pieces of an interactive launch (arch:AC-34), kept out of
 * `extension.ts` (ops ratchet): the instruction that matches the runner, the
 * last-line scrub, and the host-resume guard.
 */

export interface LaunchMarkerInput {
  readonly backend: LaunchBackend;
  readonly stage: MarkerStage | null;
  readonly core: string;
  /** The host `stage <s> pass` command prefix (extension.ts composes it from the session's CLI tokens). */
  readonly stagePrefix: (stage: MarkerStage) => string;
  readonly ticketKey: string;
  readonly hasMcp: boolean;
}

/**
 * The done-marker instruction for this launch. A sandbox has no karst MCP server and no host CLI: it
 * finishes through the bridge's emit-marker (gate-only text when the stage has no marker or no bridge
 * is attached). A host launch keeps today's `stage <s> pass` command.
 */
export function launchMarkerInstruction(input: LaunchMarkerInput): string {
  if (input.backend.sandboxed) {
    return input.stage === null || input.backend.runDir === undefined
      ? renderGateOnlyInstruction()
      : renderSandboxMarkerInstruction({ runDir: input.backend.runDir, core: input.core, stage: input.stage });
  }
  return input.stage === null
    ? renderGateOnlyInstruction()
    : renderDoneMarkerInstruction(input.stagePrefix(input.stage), input.ticketKey, input.hasMcp ? input.stage : undefined);
}

/** Scrubs host-only commands from sandboxed seed text (identity for a host launch); logs when it fired. */
export function sandboxScrubber(sandboxed: boolean, log: (message: string) => void): (text: string | undefined) => string | undefined {
  return (text) => {
    if (!sandboxed || text === undefined) return text;
    const out = scrubHostCli(text);
    if (out.scrubbed > 0) log(`scrubbed ${out.scrubbed} host-only command(s) from the sandboxed seed`);
    return out.text;
  };
}

export const TOO_LARGE_NOTE = '(too large for the sandbox, not copied)';

export interface SandboxTextInput {
  readonly sandboxed: boolean;
  readonly ticketId: number;
  readonly storageDir: string;
  /** Absent (or no `bridge`): nothing is reachable, so host paths are never emitted. */
  readonly runDir?: string | undefined;
  readonly bridge?: BridgePaths | undefined;
  readonly attachments: readonly { readonly storedName: string; readonly originalName: string }[];
  readonly log: (message: string) => void;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SPILL_POINTER = /run `karst context [^`]*` for the full state/g;

/**
 * Sandboxed text transform (arch:AC-34): mirrors the ticket's attachments into the bridge dir
 * once (add new, prune removed) and returns a `rewrite` that maps host attachment paths, host
 * gate-log paths (copied on demand, last N kept) and the spill pointer to the sandbox-visible
 * copies. Runs BEFORE `scrubHostCli`. A host launch gets the identity; the host never reads a copy back.
 */
export function sandboxTextTransform(input: SandboxTextInput): (text: string) => string {
  if (!input.sandboxed) return (text) => text;
  const { runDir, bridge } = input;
  const reachable = runDir !== undefined && bridge !== undefined;
  const attDir = join(input.storageDir, 'attachments', String(input.ticketId));
  const logDir = join(input.storageDir, 'artifacts', String(input.ticketId));
  const attState = new Map<string, boolean>(); // storedName -> copied
  if (reachable) {
    for (const a of input.attachments) {
      if (!isMirrorName(a.storedName)) continue;
      const out = mirrorFile(bridge, 'attachments', a.storedName, join(attDir, a.storedName));
      attState.set(a.storedName, out === 'copied');
      if (out !== 'copied') input.log(`attachment ${a.storedName} not mirrored into the sandbox (${out})`);
    }
    pruneMirror(bridge, 'attachments', new Set(attState.keys()));
  } else if (input.attachments.length > 0) input.log('WARN no bridge dir: attachment paths are not available in the sandbox');
  const attRef = (name: string): string => {
    if (!reachable) return NOT_IN_SANDBOX;
    const path = `${runDir}/attachments/${name}`;
    return attState.get(name) === false ? `${path} ${TOO_LARGE_NOTE}` : path;
  };
  const spilled = (field: string): string | undefined =>
    input.attachments.find((a) => a.originalName === `spilled-${field}.txt`)?.storedName;
  const attPath = new RegExp(`${escapeRe(attDir)}/([A-Za-z0-9_][A-Za-z0-9._-]*)`, 'g');
  const logPath = new RegExp(`${escapeRe(logDir)}/([A-Za-z0-9_][A-Za-z0-9._-]*)`, 'g');
  return (text) => {
    let out = text.replace(/(\[spilled to attachment shelf — (description|context brief)[^\]]*?)run `karst context [^`]*` for the full state/g,
      (_m, head: string, label: string) => {
        const name = spilled(label === 'description' ? 'description' : 'brief');
        return name !== undefined && reachable ? `${head}read ${attRef(name)} for the full text` : `${head}${NOT_IN_SANDBOX}`;
      });
    out = out.replace(SPILL_POINTER, NOT_IN_SANDBOX);
    out = out.replace(attPath, (_m, name: string) => attRef(name));
    out = out.replace(logPath, (_m, name: string) => {
      if (!reachable) { input.log('WARN no bridge dir: gate log path is not available in the sandbox'); return NOT_IN_SANDBOX; }
      const res = mirrorFile(bridge, 'logs', name, join(logDir, name));
      if (res === 'refused') { input.log(`WARN gate log ${name} not mirrored into the sandbox`); return NOT_IN_SANDBOX; }
      pruneOldLogs(bridge, MIRROR_KEEP_LOGS);
      return res === 'copied' ? `${runDir}/logs/${name}` : `${runDir}/logs/${name} ${TOO_LARGE_NOTE}`;
    });
    return out;
  };
}

export interface SeedScrubInput {
  readonly sandboxed: boolean;
  readonly store: Store;
  readonly ticketId: number;
  readonly storageDir: string;
  readonly backend: LaunchBackend;
  readonly log: (message: string) => void;
}

/** Seed text pass: host paths rewritten to the mirrored copies FIRST, then host commands scrubbed (rule 4 would eat the spill pointer). */
export function sandboxSeedScrubber(input: SeedScrubInput): (text: string | undefined) => string | undefined {
  const rewrite = sandboxTextTransform({
    sandboxed: input.sandboxed, ticketId: input.ticketId, storageDir: input.storageDir, runDir: input.backend.runDir, bridge: input.backend.bridge,
    attachments: input.sandboxed ? listAttachments(input.store, input.ticketId) : [], log: input.log,
  });
  const scrub = sandboxScrubber(input.sandboxed, input.log);
  return (text) => (text === undefined ? text : scrub(rewrite(text)));
}

export interface ResumeGuardLaunch {
  readonly ticketId: number;
  readonly ticketLabel: string;
  readonly resumeId: string | undefined;
  /** The launch runs in a sandbox (a sandbox resume is legitimate). */
  readonly sandboxed: boolean;
  readonly hasSandbox: () => Promise<boolean>;
  readonly warn: (message: string) => void;
}

/** A host launch never resumes a sandbox session id: it starts fresh (and says so). */
export async function guardLaunchResume(input: ResumeGuardLaunch): Promise<string | undefined> {
  if (input.resumeId === undefined) return undefined;
  try {
    assertNoSandboxResumeOnHost({
      ticketId: input.ticketId, resume: input.resumeId, runner: input.sandboxed ? 'docker' : 'host', hasSandbox: await input.hasSandbox(),
    });
    return input.resumeId;
  } catch (err) {
    if (!(err instanceof SandboxResumeOnHostError)) throw err;
    input.warn(`Karst: ${input.ticketLabel} has a sandbox but this launch runs on the host: starting a fresh host session instead of resuming the sandbox session.`);
    return undefined;
  }
}

import { backendForCore } from '../../agent/backendChoices.js';
import { ticketBackendSetting } from '../../agent/effectiveBackend.js';
import type { AgentBackends } from '../../agent/backendChoices.js';
export const HOST_FALLBACK_RETRY = 'Retry';
export const HOST_FALLBACK_HOST = 'Sync and remove sandbox, then run on host with a fresh session';

export interface HostFallbackInput<T extends { readonly sandboxed: boolean }> {
  readonly ticketLabel: string;
  readonly launch: () => Promise<T>;
  /** The project/ticket asked for a sandbox backend. */
  readonly wantsSandbox: boolean;
  readonly hasSandbox: () => Promise<boolean>;
  readonly choose: (message: string, options: readonly string[]) => Promise<string | undefined>;
  /** Modal naming the risk; true only on an explicit yes. */
  readonly confirmHost: (message: string) => Promise<boolean>;
  /** Sync (ff-only) then remove the sandbox; false when kept. */
  readonly removeSandbox: () => Promise<boolean>;
}

export type HostFallbackResult<T> = { readonly kind: 'launched'; readonly backend: T; readonly freshSession: boolean } | { readonly kind: 'cancelled' };

/** F14: a ticket with a sandbox never silently falls back to the host; the user picks Retry / host-after-removal / Cancel. */
export async function launchWithoutSilentHostFallback<T extends { readonly sandboxed: boolean }>(input: HostFallbackInput<T>): Promise<HostFallbackResult<T>> {
  for (;;) {
    const backend = await input.launch();
    if (backend.sandboxed || !input.wantsSandbox || !(await input.hasSandbox())) return { kind: 'launched', backend, freshSession: false };
    const picked = await input.choose(
      `Karst: the sandbox backend for ${input.ticketLabel} is unavailable, but the ticket has a sandbox with the agent's work in it.`,
      [HOST_FALLBACK_RETRY, HOST_FALLBACK_HOST],
    );
    if (picked === HOST_FALLBACK_RETRY) continue;
    if (picked !== HOST_FALLBACK_HOST) return { kind: 'cancelled' };
    const ok = await input.confirmHost(
      `The agent's sandbox commits for ${input.ticketLabel} will be synced to the host branch and the sandbox removed; the agent then runs on the host WITHOUT the sandbox boundary, in a fresh session. Continue?`,
    );
    if (!ok || !(await input.removeSandbox())) return { kind: 'cancelled' };
    return { kind: 'launched', backend: await input.launch(), freshSession: true };
  }
}

export function wantsSandboxBackend(backends: AgentBackends | undefined, core: string, override: 'host' | null | undefined): boolean {
  return (ticketBackendSetting(backendForCore(backends, core), override) ?? 'host') !== 'host';
}

/** The two prompts of the host-fallback choice, over any `showWarningMessage`. */
export function hostFallbackPrompts(win: { showWarningMessage(message: string, ...items: any[]): PromiseLike<string | undefined> }) {
  return {
    choose: async (msg: string, opts: readonly string[]) => win.showWarningMessage(msg, ...opts),
    confirmHost: async (msg: string) => (await win.showWarningMessage(msg, { modal: true }, 'Run on host')) === 'Run on host',
  };
}
