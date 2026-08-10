import { readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import type { ProjectWorktreeRow } from '../store/dashboard.js';
import {
  IDE_CLI_BINARY,
  type LaunchWorktreeConfig,
} from './launchWorktreeConfig.js';

/**
 * Launch a worktree's karst-extension build as the editor's development host —
 * the F5 equivalent without ever opening the worktree folder or typing a path.
 *
 * A karst worktree lives inside the project's hidden `.karst/worktrees/`
 * directory, so the IDE file dialogs never offer it: opening it means typing
 * the full path by hand. This is the other half of that flow: the extension
 * knows every registered worktree (they are rows in the store), builds the
 * chosen one (`npm run dev:extension`, the same recipe the F5 preLaunchTask
 * runs), and opens it in a fresh window with `--extensionDevelopmentPath`,
 * which is exactly the switch F5 passes. Host-agnostic: the vscode bindings
 * (progress, QuickPick, spawn) stay in extension.ts, everything else lives
 * here under injected effects.
 */

/**
 * A worktree that is a karst-extension checkout, i.e. launchable as a dev host.
 */
export type LaunchableWorktree = ProjectWorktreeRow;

/** `npm run dev:extension` — the compile + asset copy + electron ABI rebuild. */
export const LAUNCH_BUILD_SCRIPT = 'dev:extension';

/** A build may compile AND rebuild the native addon; give it real minutes. */
export const LAUNCH_BUILD_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Answer whether `path` is a karst-extension checkout by reading its
 * package.json. Never throws: a missing/unreadable file or a foreign package
 * name is simply "not launchable" — a wrong answer must never crash the board.
 */
export function isKarstCheckout(
  path: string,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): boolean {
  try {
    const pkg: unknown = JSON.parse(readFile(join(path, 'package.json')));
    return typeof pkg === 'object' && pkg !== null && (pkg as { name?: unknown }).name === 'karst';
  } catch {
    return false;
  }
}

/**
 * Keep the launchable rows only. The probe is injected (defaulting to the
 * filesystem check) so callers can decide how a failed read should count.
 */
export function selectLaunchableWorktrees(
  rows: readonly ProjectWorktreeRow[],
  probe: (path: string) => boolean = isKarstCheckout,
): LaunchableWorktree[] {
  return rows.filter((row) => probe(row.path));
}

/**
 * The editor's own CLI binary, derived from the running app's root. This is
 * the executable that can open a NEW window with `--extensionDevelopmentPath`
 * — the F5 switch. The layout differs by platform:
 *
 *  - darwin: `<App>.app/Contents/Resources/app/bin/code` — inside the bundle.
 *  - linux:  `<install>/bin/code` — a sibling of `resources/`.
 *  - win32:  `<install>\bin\code.cmd` — a sibling of `resources\`.
 *
 * `appRoot` is `vscode.env.appRoot`, i.e. `…/resources/app` on every platform.
 */
export function resolveCliPath(appRoot: string, platform: NodeJS.Platform): string {
  // Explicit per-platform joiners (win32/posix), never the host's ambient one:
  // the answer must depend on `platform`, not on where the test happens to run.
  if (platform === 'win32') return win32.join(appRoot, '..', '..', 'bin', 'code.cmd');
  if (platform === 'linux') return posix.join(appRoot, '..', '..', 'bin', 'code');
  return posix.join(appRoot, 'bin', 'code');
}

/** The dev-window args: load the worktree's build AND open it as the folder. */
export function devWindowArgs(worktreePath: string): readonly string[] {
  return [`--extensionDevelopmentPath=${worktreePath}`, worktreePath];
}

/** What the build step ended with. `aborted` is a user stop, not a failure. */
export type BuildOutcome =
  | { kind: 'completed'; exitCode: number; output: string }
  | { kind: 'aborted' }
  | { kind: 'failed'; message: string; output: string };

/** Terminal outcome of a launch request. */
export type LaunchOutcome =
  | { kind: 'launched'; cliPath: string; args: readonly string[] }
  | { kind: 'aborted' }
  | { kind: 'failed'; message: string };

/** The host side-effects a launch needs. */
export interface LaunchWorktreeEffects {
  build: (cwd: string, signal: AbortSignal) => Promise<BuildOutcome>;
  cliExists: (cliPath: string) => boolean;
  binaryOnPath: (binary: string) => boolean;
  spawnWindow: (cliPath: string, args: readonly string[], cwd: string) => void;
}

/** Which editor CLI the launch will use, or why it cannot. */
export type CliResolution =
  | { kind: 'resolved'; cliPath: string }
  | { kind: 'unresolved'; reason: string };

/**
 * Pick the CLI that opens the dev window. Precedence is explicit: `idePath`
 * (an exact file) beats a named `ide` (a PATH binary) beats `auto` (the
 * running editor's own bundle CLI — the one that exists for every VS Code
 * fork, whatever its name). A named IDE the user asked for but cannot find is
 * a refusal, never a silent substitution: launching a different editor than
 * requested is how a session ends up in the wrong app.
 */
export function resolveLaunchCli(
  config: LaunchWorktreeConfig,
  appRoot: string,
  platform: NodeJS.Platform,
  effects: Pick<LaunchWorktreeEffects, 'cliExists' | 'binaryOnPath'>,
): CliResolution {
  if (config.idePath) {
    return effects.cliExists(config.idePath)
      ? { kind: 'resolved', cliPath: config.idePath }
      : { kind: 'unresolved', reason: `The configured IDE path does not exist: ${config.idePath}` };
  }
  if (config.ide === 'auto') {
    const cliPath = resolveCliPath(appRoot, platform);
    return effects.cliExists(cliPath)
      ? { kind: 'resolved', cliPath }
      : { kind: 'unresolved', reason: `No editor CLI at ${cliPath} — this editor cannot open a dev window from here.` };
  }
  const binary = IDE_CLI_BINARY[config.ide];
  return effects.binaryOnPath(binary)
    ? { kind: 'resolved', cliPath: binary }
    : { kind: 'unresolved', reason: `The ${config.ide} CLI (${binary}) is not on PATH — set karst.launchWorktreeDev.idePath to its exact location.` };
}

/**
 * Build a worktree's extension and open it in a new dev window.
 *
 * The CLI is resolved BEFORE the build: a multi-minute compile must not burn
 * to discover the launcher is missing. Build failures carry the command's own
 * prose, collapsed to one capped line — it is unbounded npm output.
 */
export async function launchWorktreeDev(
  worktreePath: string,
  config: LaunchWorktreeConfig,
  appRoot: string,
  platform: NodeJS.Platform,
  effects: LaunchWorktreeEffects,
  signal?: AbortSignal,
): Promise<LaunchOutcome> {
  const cli = resolveLaunchCli(config, appRoot, platform, effects);
  if (cli.kind === 'unresolved') return { kind: 'failed', message: cli.reason };

  const build = await effects.build(worktreePath, signal ?? new AbortController().signal);
  if (build.kind === 'aborted') return { kind: 'aborted' };
  if (build.kind === 'failed' || build.exitCode !== 0) {
    return { kind: 'failed', message: `Build failed in ${worktreePath}: ${oneLine(build.output)}` };
  }

  const args = devWindowArgs(worktreePath);
  effects.spawnWindow(cli.cliPath, args, worktreePath);
  return { kind: 'launched', cliPath: cli.cliPath, args };
}

/** Collapse untrusted command output to one line and cap it (UI-R32). */
function oneLine(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  const max = 220;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
