/**
 * The oversized-kickoff backstop (T722 / D151): a kickoff that cannot ride
 * argv is written to a file and replaced by a short positional pointer.
 *
 * Linux caps ONE argv string at `MAX_ARG_STRLEN` (131072 bytes) and `execve`
 * fails with `E2BIG` above it. The kickoff is composed from ticket prose and can
 * be arbitrarily large, so every core that passes it as a positional argument
 * needs the same guard (arch:AC-08). The common path is untouched: a kickoff
 * under the threshold still rides argv byte-for-byte, keeping its prompt hash
 * and provider caching stable (arch:AC-09).
 *
 * The file lives in the launch's karst runtime dir — `<cwd>/.karst/kickoff/`
 * for a host launch, or the mounted bridge dir for a sandbox (where the host
 * path and the agent-visible path differ). A unique name per launch means the
 * adapter only ever claims a path THIS call created (arch:AC-17/AC-18); the
 * host path is returned as an owned path only when it is inside the worktree,
 * because that is the only shape session cleanup accepts.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HookChannel } from './adapter.js';

/**
 * The largest kickoff we are willing to put in a single argv entry. Linux's
 * hard cap is 128 KiB (`MAX_ARG_STRLEN`); 100 KiB keeps headroom for the
 * other ~3 KiB of `execve` bookkeeping and neighbouring arguments.
 */
export const KICKOFF_ARGV_MAX_BYTES = 100 * 1024;

/** Prefix of every spilled kickoff file, so the runtime dir stays legible. */
export const KICKOFF_FILE_PREFIX = 'karst-kickoff-';

/** The subdirectory of the launch runtime dir that holds spilled kickoffs. */
export const KICKOFF_RUNTIME_SUBDIR = 'kickoff';

export interface KickoffSpillInput {
  /** The launch's working directory (the worktree, or a karst scratch dir). */
  cwd: string;
  /** The kickoff as it would otherwise ride argv. */
  prompt: string | undefined;
  /**
   * An explicit karst-owned runtime dir. Host and agent see the same path.
   * Absent → the launch's own runtime dir is derived below.
   */
  runtimeDir?: string;
  /**
   * The launch's hook channel. A FILE channel (`runDir` set) is a sandbox:
   * the file is written into the host bridge dir (`configDir`) but named by
   * the path the agent sees (`runDir`).
   */
  hookChannel?: HookChannel;
  /** Per-launch identity for the filename; absent → a random one. */
  launchId?: string;
}

export interface KickoffSpill {
  /** The text to pass on argv: the original kickoff, or the file pointer. */
  prompt: string | undefined;
  /** Host path of the written file, when the kickoff was spilled. */
  path?: string;
  /** Host paths created by this call that session cleanup may remove. */
  ownedPaths: string[];
}

/** Whether a kickoff fits in one argv entry without risking `E2BIG`. */
export function kickoffFitsArgv(prompt: string | undefined): boolean {
  return prompt === undefined || Buffer.byteLength(prompt, 'utf8') <= KICKOFF_ARGV_MAX_BYTES;
}

/** The one-line positional prompt that replaces an oversized kickoff. */
export function renderKickoffPointer(path: string): string {
  return `Your full kickoff brief is in ${path}; read it completely before doing anything else.`;
}

/**
 * Return the kickoff to pass on argv. A small one is returned unchanged and
 * nothing is written. An oversized one is written in full to a fresh file and
 * replaced by `renderKickoffPointer`.
 */
export function spillOversizedKickoff(input: KickoffSpillInput): KickoffSpill {
  const { prompt } = input;
  if (prompt === undefined || prompt.length === 0 || kickoffFitsArgv(prompt)) {
    return { prompt, ownedPaths: [] };
  }

  const target = runtimeTarget(input);
  mkdirSync(target.hostDir, { recursive: true });
  const name = kickoffFileName(input.launchId);
  const path = join(target.hostDir, name);
  writeFileSync(path, prompt, 'utf8');

  const visiblePath = target.visibleDir ? join(target.visibleDir, name) : path;
  return {
    prompt: renderKickoffPointer(visiblePath),
    path,
    // Session cleanup only accepts worktree-local, karst-owned paths; a file
    // in global storage or the sandbox bridge is not one of them.
    ownedPaths: inside(input.cwd, path) ? [path] : [],
  };
}

interface RuntimeTarget {
  /** Where the host writes the file. */
  readonly hostDir: string;
  /** Where the agent reads it, when that differs (sandbox). */
  readonly visibleDir?: string;
}

function runtimeTarget(input: KickoffSpillInput): RuntimeTarget {
  if (input.runtimeDir !== undefined) {
    return { hostDir: input.runtimeDir, visibleDir: input.runtimeDir };
  }
  if (input.hookChannel?.runDir !== undefined) {
    return {
      hostDir: join(input.hookChannel.configDir, KICKOFF_RUNTIME_SUBDIR),
      visibleDir: join(input.hookChannel.runDir, KICKOFF_RUNTIME_SUBDIR),
    };
  }
  // A real cwd is the launch's runtime dir (a worktree or a karst scratch).
  // A caller's synthetic path (a unit test's `/wt`) has no directory to write;
  // use a private temp dir rather than fail a launch on a path that never
  // existed anyway.
  if (existsSync(input.cwd)) {
    return { hostDir: join(input.cwd, '.karst', KICKOFF_RUNTIME_SUBDIR) };
  }
  return { hostDir: join(tmpdir(), 'karst-kickoff') };
}

function kickoffFileName(launchId: string | undefined): string {
  const token = (launchId ?? 'launch').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'launch';
  return `${KICKOFF_FILE_PREFIX}${token}-${randomUUID().slice(0, 8)}.md`;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
