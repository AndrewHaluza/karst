import type { RemoteDef } from '../../manifest/types.js';
import { OPENCODE2_AUTH_LIST_ARGS, opencode2HasCredentials } from '../opencode2Auth.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../sbx/sbxProcess.js';
import { SSH_CORES, type SshCore } from '../sandboxCores.js';
import type { SandboxTicketRef, SessionRunner } from '../sessionRunner.js';
import { ensureSshClone, sshRemotePaths, type SshCloneContext } from './sshClone.js';
import { ensureSshControlDir, sshControlDir } from './sshControlDir.js';
import type { SshGateRegistry } from './sshGateRegistry.js';
import { sshProjectPrefix, sshSandboxName } from './sshNames.js';
import { sshPreflight, type SshPreflightOptions, type SshPreflightResult } from './sshPreflight.js';
import { NODE_SSH_PROCESS, SSH_BIN, sshArgv, type SshProcess } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';
import { createSshSessionRunner } from './sshRunner.js';
import { ensureRemoteWorkspaceTrusted, type RemoteTrustInput } from './sshTrust.js';

/**
 * Resolve the `ssh:<name>` backend for one launch (D555, edit 7). The trust
 * check is first and makes no ssh call; then the remote lookup, the mode, the
 * preflight, the core login, the names, the clone and the workspace trust, in
 * that order. Every failure is a bare reason (the resolver adds `host (…)`),
 * the whole step is bounded, and this function never throws.
 */

/** The bound of the whole resolve step. */
export const SSH_RESOLVE_TIMEOUT_MS = 180_000;
const LOGIN_STDOUT_BYTES = 16 * 1024;

/** The once-per-window state of the no-tmux warning (one set per extension window). */
export interface SshWarnOnce {
  readonly warned: Set<string>;
}

export const WINDOW_SSH_WARN_ONCE: SshWarnOnce = { warned: new Set<string>() };

export interface SshResolveDeps {
  readonly ssh?: SshProcess;
  readonly sshBin?: string;
  readonly host?: SbxProcess;
  readonly controlDir?: string;
  readonly ensureControlDir?: (dir: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  readonly preflight?: (name: string, remote: RemoteDef, proc: SshProcess, opts: SshPreflightOptions) => Promise<SshPreflightResult>;
  readonly clone?: typeof ensureSshClone;
  readonly trust?: (input: RemoteTrustInput) => Promise<void>;
  readonly registry?: SshGateRegistry;
  readonly timeoutMs?: number;
  readonly warnOnce?: SshWarnOnce;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

export interface SshResolveInput {
  readonly remoteName: string;
  readonly remotes: Readonly<Record<string, RemoteDef>> | undefined;
  /** The host-side trust record (`ssh-trust.json`): checked before any ssh call. */
  readonly remoteTrusted: (name: string) => boolean;
  readonly core: string;
  readonly projectRoot: string;
  readonly installId: string;
  readonly ticketId: number;
  readonly worktree: SandboxTicketRef | undefined;
  readonly deps?: SshResolveDeps;
}

export interface SshNames {
  readonly remote: string;
  readonly name: string;
}

export type SshResolution =
  | { readonly ok: true; readonly runner: SessionRunner; readonly names: SshNames; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

interface LoginCheck {
  readonly script: string;
  readonly signedIn: (stdout: string) => boolean;
  readonly fix: string;
}

/**
 * The remote sign-in signal of each core, the same files the host probe reads
 * (`signedInProbe.ts`); opencode2 uses `auth list` (never `auth export`). The
 * script prints only `yes`/`no` or the provider list, never a secret.
 */
function loginCheck(core: SshCore, coreBin: string): LoginCheck {
  const yes = (stdout: string): boolean => stdout.trim() === 'yes';
  switch (core) {
    case 'claude':
      return {
        script: `d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; if [ -f "$d/.credentials.json" ] || grep -q '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null; then echo yes; else echo no; fi`,
        signedIn: yes,
        fix: 'claude (then /login)',
      };
    case 'codex':
      return { script: `if [ -f "\${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then echo yes; else echo no; fi`, signedIn: yes, fix: 'codex login' };
    case 'opencode':
      return {
        script: `if [ -f "\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" ]; then echo yes; else echo no; fi`,
        signedIn: yes,
        fix: 'opencode auth login',
      };
    case 'opencode2':
      return {
        script: [coreBin, ...OPENCODE2_AUTH_LIST_ARGS].map(sshQuote).join(' ') + ' 2>/dev/null',
        signedIn: opencode2HasCredentials,
        fix: 'opencode2 auth login',
      };
  }
}

function isSshCore(core: string): core is SshCore {
  return (SSH_CORES as readonly string[]).includes(core);
}

async function checkLogin(ssh: SshProcess, remote: RemoteDef, controlDir: string, name: string, core: SshCore, coreBin: string): Promise<string | undefined> {
  const check = loginCheck(core, coreBin);
  const out = await ssh.run(sshArgv(remote, controlDir, `# karst-ssh-login\n${check.script}`), { maxStdoutBytes: LOGIN_STDOUT_BYTES });
  if (out.transport === true) return `ssh ${name}: transport failed during the ${core} sign-in check`;
  if (check.signedIn(out.stdout)) return undefined;
  return `ssh ${name}: ${core} is not signed in on the remote; run \`${check.fix}\` on ${remote.user}@${remote.host}`;
}

async function resolveSteps(input: SshResolveInput, signal: AbortSignal): Promise<SshResolution> {
  const name = input.remoteName;
  const deps = input.deps ?? {};
  const remote = input.remotes?.[name];
  if (remote === undefined) return { ok: false, reason: `ssh: remote '${name}' is not in remotes` };
  if (remote.mode === 'docker') return { ok: false, reason: 'ssh docker mode not available yet' };
  if (!isSshCore(input.core)) return { ok: false, reason: `${input.core}: ssh backend unsupported` };
  const worktree = input.worktree;
  if (!worktree?.branch) return { ok: false, reason: 'ssh: ticket has no worktree branch to clone' };
  const ssh = deps.ssh ?? NODE_SSH_PROCESS;
  const controlDir = deps.controlDir ?? sshControlDir();
  const control = await (deps.ensureControlDir ?? ensureSshControlDir)(controlDir);
  if (!control.ok) return control;
  const pre = await (deps.preflight ?? sshPreflight)(name, remote, ssh, { controlDir, core: input.core });
  if (!pre.ok) return pre;
  const coreBin = pre.facts.coreBin ?? input.core;
  const notSignedIn = await checkLogin(ssh, remote, controlDir, name, input.core, coreBin);
  if (notSignedIn !== undefined) return { ok: false, reason: notSignedIn };
  const sandboxName = sshSandboxName(input.projectRoot, input.installId, input.ticketId, input.core);
  const ctx: SshCloneContext = {
    ssh, sshBin: deps.sshBin ?? SSH_BIN, host: deps.host ?? NODE_SBX_PROCESS, remote, remoteName: name, sandboxName, controlDir,
    ...(deps.debug ? { debug: deps.debug } : {}),
  };
  const cloned = await (deps.clone ?? ensureSshClone)(ctx, { hostWorktreePath: worktree.hostWorktreePath, branch: worktree.branch, ...(worktree.baseRef ? { baseRef: worktree.baseRef } : {}) });
  if (!cloned.ok) return { ok: false, reason: cloned.reason };
  await (deps.trust ?? ensureRemoteWorkspaceTrusted)({
    ssh, remote, controlDir, core: input.core, remoteCwd: sshRemotePaths(ctx).repo, remoteName: name, signal,
    ...(deps.warn ? { warn: deps.warn } : {}), ...(deps.debug ? { debug: deps.debug } : {}),
  });
  const warnings = [...pre.warnings];
  if (!pre.facts.tmux) {
    const once = deps.warnOnce ?? WINDOW_SSH_WARN_ONCE;
    const text = warnings.find((w) => w.includes('tmux not found')) ?? `ssh ${name}: tmux not found; the agent stops when the connection drops (install tmux)`;
    if (!warnings.includes(text)) warnings.push(text);
    if (!once.warned.has(name)) {
      once.warned.add(name);
      deps.warn?.(text);
    }
  }
  const runner = createSshSessionRunner({
    ssh, sshBin: ctx.sshBin, host: ctx.host, remote, remoteName: name, sandboxName,
    projectPrefix: sshProjectPrefix(input.projectRoot, input.installId), controlDir, core: input.core,
    ticketId: input.ticketId, hostWorktreePath: worktree.hostWorktreePath, tmux: pre.facts.tmux, coreBin,
    ...(deps.registry ? { registry: deps.registry } : {}), ...(deps.debug ? { debug: deps.debug } : {}),
  });
  return { ok: true, runner, names: { remote: name, name: sandboxName }, warnings };
}

export async function resolveSsh(input: SshResolveInput): Promise<SshResolution> {
  // Trust first: an unconfirmed remote gets no connection at all.
  if (!input.remoteTrusted(input.remoteName)) return { ok: false, reason: `ssh: remote '${input.remoteName}' not confirmed` };
  const timeoutMs = input.deps?.timeoutMs ?? SSH_RESOLVE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SshResolution>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: `ssh ${input.remoteName}: setup did not finish in ${String(Math.round(timeoutMs / 1000))} s` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([resolveSteps(input, controller.signal), timedOut]);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
