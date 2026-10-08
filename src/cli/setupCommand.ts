import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { discoverWorkspace, type DiscoveryProbe } from '../setup/discover.js';
import { MAX_SETUP_PROPOSAL_BYTES, validateSetupProposal, type ChangeProposal } from '../setup/proposal.js';
import { resolveSetupOutboxDir, writeSetupProposal } from '../setup/outbox.js';

/**
 * `karst setup discover [--root <path>] [--default-branch <branch>]` and
 * `karst setup propose-change` (one JSON object on stdin).
 *
 * `discover` runs the deterministic engine (`setup/discover.ts`) over a real
 * filesystem + git probe and prints the facts the agent reasons over: the
 * repositories, each one's DETECTED baseline branch, and its service candidate
 * (or null plus a reason). It never writes anything.
 *
 * `propose-change` validates a `kind: 'change'` object and writes it into
 * `$KARST_SETUP_OUTBOX`. The extension shows the exact command/patch and applies
 * it only after the user agrees — the agent cannot edit a tracked file itself.
 */

export interface SetupCommandDeps {
  outboxEnv?: string;
  uuid?: () => string;
  /** Read stdin, at most `max` bytes. Injected by main.ts. */
  readStdin?: (max: number) => string;
  /** Injectable probe for tests; a real fs+git probe is used by default. */
  probe?: DiscoveryProbe;
  /** Workspace root when `--root` is absent. */
  cwd?: string;
  defaultBranch?: string;
}

const DISCOVER_USAGE = 'usage: karst setup discover [--root <path>] [--default-branch <branch>]';
const PROPOSE_USAGE = "usage: printf '%s' '<json>' | karst setup propose-change";

/** The real probe: fs reads + `git -C <dir> …` (this runs in the CLI process). */
export function realDiscoveryProbe(): DiscoveryProbe {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    exists: (p) => existsSync(p),
    git: (dir, args) => {
      try {
        return execFileSync('git', ['-C', dir, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return undefined;
      }
    },
  };
}

function parseDiscover(rest: readonly string[], deps: SetupCommandDeps): { root: string; defaultBranch: string } {
  let root = deps.cwd ?? process.cwd();
  let defaultBranch = deps.defaultBranch ?? 'main';
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--root') {
      const value = rest[++i];
      if (value === undefined) throw new Error(`karst setup discover: --root needs a path (${DISCOVER_USAGE})`);
      root = value;
    } else if (token === '--default-branch') {
      const value = rest[++i];
      if (value === undefined) throw new Error(`karst setup discover: --default-branch needs a value (${DISCOVER_USAGE})`);
      defaultBranch = value;
    } else {
      throw new Error(`karst setup discover: unknown argument '${token}' (${DISCOVER_USAGE})`);
    }
  }
  return { root, defaultBranch };
}

function runDiscover(rest: readonly string[], deps: SetupCommandDeps): string {
  const { root, defaultBranch } = parseDiscover(rest, deps);
  const probe = deps.probe ?? realDiscoveryProbe();
  // A mistyped `--root` must not read as an empty greenfield workspace: that is
  // a silent, wrong "nothing here" answer the user would act on.
  if (!probe.exists(root)) {
    throw new Error(`karst setup discover: --root ${root} does not exist`);
  }
  const result = discoverWorkspace(root, probe, defaultBranch);
  return JSON.stringify(result, null, 2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A change object arrives in one of two shapes: the full proposal the shell
 * path pipes in (`{kind:'change',…}`), or the flat MCP tool object
 * (`{subcommand:'propose-change', repo, reason, command?}`). Normalize the
 * latter so an MCP call is not rejected for a missing `kind`.
 */
function normalizeChangeInput(raw: unknown): unknown {
  if (isRecord(raw) && raw.kind === undefined && typeof raw.subcommand === 'string') {
    return toChangeProposalInput(raw);
  }
  return raw;
}

function readChange(deps: SetupCommandDeps): unknown {
  const read = deps.readStdin ?? ((max: number) => readFileSync(0, { encoding: 'utf8' }).slice(0, max));
  const raw = read(MAX_SETUP_PROPOSAL_BYTES);
  if (Buffer.byteLength(raw, 'utf8') > MAX_SETUP_PROPOSAL_BYTES) {
    throw new Error(`karst setup propose-change: input is too large (max ${MAX_SETUP_PROPOSAL_BYTES} bytes)`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('karst setup propose-change: stdin is not one JSON object');
  }
}

function runProposeChange(deps: SetupCommandDeps): string {
  const checked = validateSetupProposal(normalizeChangeInput(readChange(deps)));
  if (!checked.ok) throw new Error(`karst setup propose-change: ${checked.reason}`);
  if (checked.value.kind !== 'change') {
    throw new Error("karst setup propose-change: kind must be 'change' (use `karst manifest propose` for a manifest)");
  }
  const dir = resolveSetupOutboxDir(deps.outboxEnv);
  const out = writeSetupProposal(dir, checked.value as ChangeProposal, deps.uuid);
  return JSON.stringify({ ok: true, kind: 'change', file: out });
}

/**
 * Turn a structured `setup` tool object (`{subcommand, repo, reason, command?}`)
 * into the change-proposal payload the handler validates: `kind:'change'` plus
 * the change fields. Used only for the `--file`/`--stdin` path; the shell path
 * already supplies the full proposal on stdin.
 */
export function toChangeProposalInput(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: 'change' };
  for (const key of ['repo', 'reason', 'command', 'patch']) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

export function runSetupCommand(argv: readonly string[], deps: SetupCommandDeps = {}): string {  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'setup') throw new Error(`karst setup: unknown command '${cmd ?? ''}'`);
  if (sub === 'discover') return runDiscover(rest, deps);
  if (sub === 'propose-change') {
    if (rest.length > 0) throw new Error(`karst setup propose-change takes no arguments or flags (${PROPOSE_USAGE})`);
    return runProposeChange(deps);
  }
  throw new Error(`karst setup: unknown subcommand '${sub ?? ''}' (want 'discover' or 'propose-change')`);
}
