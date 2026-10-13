/**
 * Provider-native sandbox mode (`arch:AC-30`, ST1 of T667).
 *
 * A session may run with relaxed permission prompts ONLY when the core's own
 * OS-level sandbox contains it. Everything here fails closed: an unrequested,
 * unsupported or unenforceable sandbox resolves to `prompted` — today's
 * behaviour — with the reason, never to host + bypass flags.
 */
import { isAbsolute, join, resolve } from 'node:path';
import type { SurfaceSupport } from './surfaces.js';

/** The headless permission mode that turns prompts off (a bypass on an unsandboxed run). */
export const BYPASS_PERMISSION_MODE = 'bypassPermissions';

/** OSes on which claude (Seatbelt / bubblewrap) and codex (Seatbelt / Landlock) enforce their sandbox. */
const SANDBOX_PLATFORMS: readonly string[] = ['darwin', 'linux'];

/** Network allowlist of a sandboxed session: provider APIs + package registries, nothing else. */
export const SANDBOX_NETWORK_ALLOWLIST: readonly string[] = [
  'api.anthropic.com',
  'api.openai.com',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'rubygems.org',
];

/** What a sandboxed launch may touch. */
export interface SandboxPolicy {
  /** Directories the session may write: the ticket worktree, plus its shared git dir so commits work. */
  readonly writableRoots: readonly string[];
  readonly allowedDomains: readonly string[];
}

export type EffectiveSandbox =
  | { readonly mode: 'sandboxed'; readonly policy: SandboxPolicy }
  | { readonly mode: 'prompted'; readonly reason: string };

export interface ResolveSandboxInput {
  /** The manifest's `agentSandbox` opt-in. */
  requested: boolean;
  /** The adapter's declared `surfaces.sandboxInteractive`. */
  surface: SurfaceSupport;
  platform: string;
  cwd: string;
  gitCommonDir?: string;
}

export function resolveSandbox(input: ResolveSandboxInput): EffectiveSandbox {
  if (!input.requested) return { mode: 'prompted', reason: 'sandbox not enabled (agentSandbox: false)' };
  if (!input.surface.supported) {
    return { mode: 'prompted', reason: `core cannot sandbox: ${input.surface.reason}` };
  }
  if (!SANDBOX_PLATFORMS.includes(input.platform)) {
    return { mode: 'prompted', reason: `platform ${input.platform} has no supported OS sandbox` };
  }
  const writableRoots = input.gitCommonDir ? [input.cwd, input.gitCommonDir] : [input.cwd];
  return { mode: 'sandboxed', policy: { writableRoots, allowedDomains: SANDBOX_NETWORK_ALLOWLIST } };
}

/** One bounded line for the session diagnostics. */
export function formatSandboxMode(effective: EffectiveSandbox): string {
  return effective.mode === 'sandboxed'
    ? `sandboxed (write: ${effective.policy.writableRoots.join(', ')})`
    : `prompted (${effective.reason})`;
}

/**
 * A headless run on a core with no enforced sandbox never gets the bypass:
 * the mode is dropped (the run keeps the core's prompted default) and the
 * refusal is debug-logged. Every other mode passes through unchanged.
 */
export function refuseUnsandboxedBypass(
  agent: string,
  mode: string | undefined,
  debug?: (message: string) => void,
): string | undefined {
  if (mode !== BYPASS_PERMISSION_MODE) return mode;
  debug?.(`[agent:${agent}] refused permissionMode ${mode}: no enforced sandbox on this run (AC-30)`);
  return undefined;
}

/**
 * The shared git dir of a linked worktree (`<cwd>/.git` is a `gitdir:` file).
 * A commit writes objects and refs there, so a sandbox that allows only the
 * worktree would make every commit fail. Undefined when it cannot be read.
 */
export function worktreeGitCommonDir(cwd: string, readFile: (path: string) => string): string | undefined {
  let gitDir: string;
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFile(join(cwd, '.git')));
    if (!match) return undefined;
    gitDir = resolve(cwd, match[1]!.trim());
  } catch {
    // Not a linked worktree (a plain `.git` dir, or no checkout): nothing extra to open.
    return undefined;
  }
  try {
    const common = readFile(join(gitDir, 'commondir')).trim();
    return isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    // No `commondir` file: the gitdir IS the shared dir.
    return gitDir;
  }
}
