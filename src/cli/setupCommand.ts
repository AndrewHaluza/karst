import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { loadManifestWithDiagnostics } from '../manifest/load.js';
import { canonicalRepoId } from '../runtime/repoId.js';
import { describeGraphDeps, type GraphDepsFit } from '../setup/graphDeps.js';
import { discoverWorkspace, type DiscoveryProbe } from '../setup/discover.js';
import { MAX_SETUP_PROPOSAL_BYTES } from '../setup/proposal.js';
import { basename } from 'node:path';
import { resolveSetupOutboxDir } from '../setup/outbox.js';
import { readLedger, withdrawProposal } from '../setup/ledger.js';
import { readVerifyRecords } from '../setup/verify/record.js';
import { listEdits, runEditTool, isEditTool, withdrawEditOp } from './setupEdit/command.js';
import type { EditCommandDeps } from './setupEdit/command.js';
import { validateSkipRequest, writeSkipRequest } from '../setup/checklist/skips.js';

/**
 * `karst setup discover [--root <path>] [--default-branch <branch>]` and
 * the typed setup tools (`set-*`, `run`, `write-file`, ...).
 *
 * `discover` runs the deterministic engine (`setup/discover.ts`) over a real
 * filesystem + git probe and prints the facts the agent reasons over: the
 * repositories, each one's DETECTED baseline branch, and its service candidate
 * (or null plus a reason). It never writes anything.
 *
 * The typed tools write into `$KARST_SETUP_OUTBOX`. The extension shows the exact
 * command or diff and acts only after the user agrees. The agent cannot edit a
 * tracked file itself, and the old free `change` proposal does not exist.
 */

export interface SetupCommandDeps {
  outboxEnv?: string;
  /** Extra deps for the typed edit tools (`KARST_SETUP_SESSION`, stdin, file reader). */
  edit?: Omit<EditCommandDeps, 'outboxEnv' | 'manifestPath'>;
  /** The host-side verify record directory (`setupVerifyDir`); absent means no host record. */
  verifyDirEnv?: string;
  uuid?: () => string;
  /** Read stdin, at most `max` bytes. Injected by main.ts. */
  readStdin?: (max: number) => string;
  /** Injectable probe for tests; a real fs+git probe is used by default. */
  probe?: DiscoveryProbe;
  /** Workspace root when `--root` is absent. */
  cwd?: string;
  defaultBranch?: string;
  /** The karst.yml of the project, when known: a repository with a `graphWorkspace` block already fits. */
  manifestPath?: string;
  /** Injectable graph-deps verdict for tests; the real fs check is the default. */
  graphDeps?: (repoPath: string) => GraphDepsFit;
}

const DISCOVER_USAGE = 'usage: karst setup discover [--root <path>] [--default-branch <branch>]';

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

/** Canonical names of the repositories whose karst.yml entry already has a `graphWorkspace` block. */
function configuredGraphWorkspaces(manifestPath: string | undefined): ReadonlySet<string> {
  if (!manifestPath || !existsSync(manifestPath)) return new Set();
  try {
    const { manifest } = loadManifestWithDiagnostics(manifestPath);
    return new Set(
      Object.entries(manifest.repositories ?? {})
        .filter(([, repo]) => repo.graphWorkspace !== undefined && Object.keys(repo.graphWorkspace).length > 0)
        .map(([name]) => canonicalRepoId(name)),
    );
  } catch (err) {
    process.stderr.write(`karst: setup discover could not read the manifest (${err instanceof Error ? err.message : String(err)}); graph deps are checked per repository\n`);
    return new Set();
  }
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
  // D647: the verdict of the D644 graph-workspace defaults, per repository.
  const graphDeps = deps.graphDeps ?? describeGraphDeps;
  const configured = configuredGraphWorkspaces(deps.manifestPath);
  const repos = result.repos.map((repo) => ({
    ...repo,
    graphDeps: configured.has(canonicalRepoId(repo.name))
      ? ({ status: 'fits', reason: 'graphWorkspace is already set in karst.yml' } satisfies GraphDepsFit)
      : graphDeps(repo.path),
  }));
  return JSON.stringify({ ...result, repos }, null, 2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readChange(deps: SetupCommandDeps, label: string): unknown {
  const read = deps.readStdin ?? ((max: number) => readFileSync(0, { encoding: 'utf8' }).slice(0, max));
  const raw = read(MAX_SETUP_PROPOSAL_BYTES);
  if (Buffer.byteLength(raw, 'utf8') > MAX_SETUP_PROPOSAL_BYTES) {
    throw new Error(`karst setup ${label}: input is too large (max ${MAX_SETUP_PROPOSAL_BYTES} bytes)`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`karst setup ${label}: stdin is not one JSON object`);
  }
}

/**
 * `setup skip`: the agent files a skip REQUEST. Nothing here marks an item
 * skipped. The host asks the user, and only an approval is recorded, in
 * extension storage (`setup/checklist/skips.ts`).
 */
function runSkip(rest: readonly string[], deps: SetupCommandDeps): string {
  if (rest.length > 0) throw new Error('karst setup skip takes no arguments or flags (the request is one JSON object on stdin)');
  const raw = readChange(deps, 'skip');
  const { subcommand: _subcommand, ...request } = isRecord(raw) ? raw : ({} as Record<string, unknown>);
  const checked = validateSkipRequest(isRecord(raw) ? request : raw);
  if (!checked.ok) throw new Error(`karst setup skip: ${checked.reason}`);
  const file = writeSkipRequest(resolveSetupOutboxDir(deps.outboxEnv), checked.value, deps.uuid);
  return JSON.stringify({ ok: true, kind: 'skip', id: basename(file, '.json'), status: 'requested', file });
}

function runStatus(rest: readonly string[], deps: SetupCommandDeps): string {
  if (rest.length > 0) throw new Error('karst setup status takes no arguments');
  const proposals = readLedger(resolveSetupOutboxDir(deps.outboxEnv));
  // The host record is authoritative: the outbox ledger is agent-writable, so a proposal is `verified` only here.
  const records = new Map(readVerifyRecords(deps.verifyDirEnv).map((r) => [r.id, r]));
  const shown = proposals.map((p) => {
    const rec = records.get(p.id);
    return {
      ...p,
      status: p.status === 'verified' && rec?.status !== 'verified' ? 'applied' : p.status,
      ...(rec !== undefined ? { verification: { status: rec.status, steps: rec.steps, changes: rec.changes } } : {}),
    };
  });
  return JSON.stringify({ ok: true, proposals: shown, edits: listEdits(deps.outboxEnv) }, null, 2);
}

function runWithdraw(rest: readonly string[], deps: SetupCommandDeps): string {
  const [id, ...extra] = rest;
  if (id === undefined || extra.length > 0) throw new Error('usage: karst setup withdraw <id>');
  const outbox = resolveSetupOutboxDir(deps.outboxEnv);
  // An edit op id first: the host applies only the ops still in the list after its popup.
  if (withdrawEditOp(outbox, id).ok) return JSON.stringify({ ok: true, id, status: 'withdrawn' });
  const result = withdrawProposal(outbox, id);
  if (!result.ok) throw new Error(`karst setup withdraw: ${result.error}`);
  return JSON.stringify({ ok: true, id, status: 'withdrawn' });
}

export function runSetupCommand(argv: readonly string[], deps: SetupCommandDeps = {}): string {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'setup') throw new Error(`karst setup: unknown command '${cmd ?? ''}'`);
  if (sub === 'discover') return runDiscover(rest, deps);
  if (isEditTool(sub)) return runEditTool(sub!, rest, { ...deps, ...deps.edit });
  if (sub === 'skip') return runSkip(rest, deps);
  if (sub === 'status') return runStatus(rest, deps);
  if (sub === 'withdraw') return runWithdraw(rest, deps);
  throw new Error(
    `karst setup: unknown subcommand '${sub ?? ''}' (want 'discover', a typed tool, 'skip', 'checklist', 'status' or 'withdraw')`,
  );
}
