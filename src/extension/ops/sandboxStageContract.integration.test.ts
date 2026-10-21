import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { bridgePaths, ensureBridgeDir, type BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { createBridgeAttachment, type BridgeAttachment, type MarkerRunner } from '../../agent/bridge/bridgeSink.js';
import { writeBridgeScripts } from '../../agent/hookBridgeFiles.js';
import { renderSandboxMarkerInstruction } from '../../agent/sandboxInstructions.js';
import { createSbxSessionRunner } from '../../agent/sbx/sbxRunner.js';
import type { ProcessResult, SbxProcess } from '../../agent/sbx/sbxProcess.js';
import type { MarkerStage } from '../../agent/markerStage.js';
import { runStageCommand } from '../../cli/stage.js';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, setStageCurrent } from '../../store/tickets.js';
import { STAGE_GRAPH } from '../../workflow/graph.js';
import type { StageKey } from '../../model/types.js';
import { createMarkerRunner } from './markerRunner.js';

/**
 * F7: the stage contract end to end, minus the container itself. The "agent" is a
 * stub process; everything else is real: the rendered instruction (the command is
 * PARSED from the text, so script path, events path and ticket-dir name are pinned
 * together), the emit-marker script, the bridge poller + verifier + marker flow,
 * the host's bundle sync into the worktree, and the stage machine. The runner is
 * the sbx one with a local `exec` shim, so the sandbox is "a clone on disk".
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'karst-stage-contract-')));
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

/** `sbx exec <n> -- cmd…` runs cmd locally in cwd (the clone); every other command is real. */
const localSbx: SbxProcess = {
  run: (command, args, opts) => {
    const argv = command === 'sbx' ? args.slice(args.indexOf('--') + 1) : [command, ...args];
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd: opts?.cwd, encoding: 'utf8', env: { ...process.env, ...opts?.env } });
    return Promise.resolve<ProcessResult>({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
  },
};

interface Rig {
  readonly store: Store;
  readonly ticketId: number;
  readonly wt: string;
  readonly clone: string;
  readonly paths: BridgePaths;
  readonly instruction: string;
  attach(runMarker?: MarkerRunner): BridgeAttachment;
  /** The stub agent: run the command parsed from the rendered instruction in `cwd`. */
  runMarkerCommand(cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
  commit(): void;
}

let n = 0;
const rigs: Array<() => void> = [];

function rig(stage: MarkerStage): Rig {
  const dir = join(root, String(++n));
  const wt = join(dir, 'wt');
  const clone = join(dir, 'clone');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'feat', wt]);
  git(wt, ...ID, 'commit', '-q', '--allow-empty', '-m', 'base');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', wt, clone]);

  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'K-1', title: 't' }).id;
  store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'app', ?, 'feat', 'main', 'inherited')").run(ticketId, wt);
  setStageCurrent(store, ticketId, stage as StageKey);
  rigs.push(() => store.close());

  const paths = bridgePaths(join(dir, 'bridge'), ticketId);
  const sbx = createSbxSessionRunner({ proc: localSbx, core: 'claude', name: 'karst-ab12cd34-1-claude', existing: [], cloneDir: clone, evidenceDir: paths.dir });
  const runDir = sbx.bridgeRunDir!(paths);
  const instruction = renderSandboxMarkerInstruction({ runDir, core: 'claude', stage });

  const realMarker: MarkerRunner = createMarkerRunner(
    {
      nodePath: process.execPath, cliEntry: 'cli.js', dbPath: 'db', manifestPath: 'm.yml', ticketKey: 'K-1', cwd: wt,
      ensureSynced: async () => {
        const synced = await sbx.sync!({ hostWorktreePath: wt, branch: 'feat' });
        return synced.ok ? { ok: true } : { ok: false, reason: synced.reason, diverged: /not a fast-forward/.test(synced.reason) };
      },
    },
    // The stage CLI, in process: the same function `karst stage <s> pass` runs.
    async (_cmd, args) => {
      try {
        runStageCommand(store, ticketId, [args[1]!, args[2]!, args[3]!]);
        return { stdout: '', stderr: '', exitCode: 0 };
      } catch (err) {
        return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
      }
    },
  );

  return {
    store, ticketId, wt, clone, paths, instruction,
    attach: (runMarker = realMarker) => {
      const attachment = createBridgeAttachment({
        paths,
        expect: { ticketId, worktreePath: wt, launchId: undefined, stage: () => getTicket(store, ticketId).stageCurrent as StageKey | null, sessionId: () => undefined, sessionLaunchId: () => undefined },
        dispatch: () => undefined,
        runMarker,
        intervalMs: 20,
      });
      attachment.start();
      rigs.push(() => void attachment.stop());
      return attachment;
    },
    runMarkerCommand: (cwd = clone) => {
      const command = /`(node [^`]+emit-marker\.cjs[^`]+)`/.exec(instruction)?.[1];
      if (!command) throw new Error('no marker command in the rendered instruction');
      return new Promise((resolve) => {
        const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, KARST_MARKER_WAIT_MS: '20000' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
    commit: () => {
      writeFileSync(join(clone, 'work.txt'), 'agent work');
      git(clone, 'add', '-A');
      git(clone, ...ID, 'commit', '-q', '-m', 'agent work');
    },
  };
}

async function prepare(stage: MarkerStage): Promise<Rig> {
  const r = rig(stage);
  await ensureBridgeDir(r.paths);
  writeBridgeScripts(join(r.paths.dir, 'claude'));
  return r;
}

const events = (p: BridgePaths): Array<Record<string, unknown>> =>
  existsSync(p.eventsFile) ? readFileSync(p.eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];

afterEach(() => {
  while (rigs.length > 0) rigs.pop()!();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('sandbox stage contract (F7)', () => {
  it.each(['impl', 'fix'] as const)('%s: commit → emit-marker → host syncs (ff) → stage pass → next configured stage', async (stage) => {
    const r = await prepare(stage);
    r.attach();
    r.commit();
    const out = await r.runMarkerCommand();
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('accepted');
    // The expected stage comes from the stage graph, never hard-coded.
    expect(getTicket(r.store, r.ticketId).stageCurrent).toBe(STAGE_GRAPH[stage].passed);
    expect(git(r.wt, 'rev-parse', 'HEAD')).toBe(git(r.clone, 'rev-parse', 'HEAD'));
    expect(events(r.paths).map((e) => e['kind'])).toEqual(['marker']);
    expect(events(r.paths)[0]).toMatchObject({ stage });
    const replies = readFileSync(join(r.paths.resultsDir, `${String(events(r.paths)[0]!['seq'])}.json`), 'utf8');
    expect(JSON.parse(replies)).toMatchObject({ ok: true, stage });
  });

  it('exit 3: a transient host failure is queued ("retrying"), not a failure', async () => {
    const r = await prepare('impl');
    r.attach(async () => ({ code: 1, stderr: 'sync failed: net down', transient: true }));
    r.commit();
    const out = await r.runMarkerCommand();
    expect(out.code).toBe(3);
    expect(out.stdout).toContain('queued');
    expect(getTicket(r.store, r.ticketId).stageCurrent).toBe('impl');
  });

  it('exit 1: a permanent host refusal carries its reason on stderr', async () => {
    const r = await prepare('impl');
    r.attach(async () => ({ code: 1, stderr: 'karst: cannot mark this stage done: no repository has changes' }));
    r.commit();
    const out = await r.runMarkerCommand();
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('no repository has changes');
  });

  it('a dirty tree exits 1 locally and writes no line', async () => {
    const r = await prepare('impl');
    r.attach();
    writeFileSync(join(r.clone, 'uncommitted.txt'), 'x');
    const out = await r.runMarkerCommand();
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('Commit your changes first');
    expect(events(r.paths)).toEqual([]);
    expect(getTicket(r.store, r.ticketId).stageCurrent).toBe('impl');
  });

  it('a failing `git status` (not a repository) exits 1 and writes no line', async () => {
    const r = await prepare('impl');
    r.attach();
    const plain = mkdtempSync(join(root, 'plain-'));
    const out = await r.runMarkerCommand(plain);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('git status failed');
    expect(events(r.paths)).toEqual([]);
  });

  it('reload: drop the poller, reattach on the same bridge dir, then the marker still advances the stage', async () => {
    const r = await prepare('impl');
    const first = r.attach();
    await first.stop();
    r.commit();
    r.attach(); // reattach after a VS Code reload
    const out = await r.runMarkerCommand();
    expect(out.code).toBe(0);
    expect(getTicket(r.store, r.ticketId).stageCurrent).toBe(STAGE_GRAPH.impl.passed);
  });
});

