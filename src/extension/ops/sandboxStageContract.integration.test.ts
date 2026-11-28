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
import { assertFixHasNewCommit, snapshotFixRoundHeads, NO_NEW_COMMIT_REASON } from '../../workflow/fixRoundGuard.js';
import { openRecoveryRound } from '../../store/recoveryRounds.js';
import { defaultGitRunner } from '../../integrations/git.js';
import { writeInboxFile } from '../../agent/bridge/inbox.js';
import { recordRemoteTrust } from '../../agent/ssh/remoteTrust.js';
import { makeFakeSshBin, type FakeSshBin } from '../../agent/ssh/fakeSshBin.js';
import { createNodeSshProcess, sshArgv, type SshProcess } from '../../agent/ssh/sshProcess.js';
import { sshQuote } from '../../agent/ssh/sshQuote.js';
import { mirrorToRemote } from '../../agent/ssh/sshMirror.js';
import { startSshBridgeForwarder, stopAllSshBridgeForwarders } from '../../agent/ssh/sshBridge.js';
import { uploadBridgeScripts } from '../../agent/ssh/sshBridge.js';
import type { RemoteDef } from '../../manifest/types.js';

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
        // The CLI entry's async pre-check (cli/main.ts assertMarkerHasWork), then the sync marker.
        if (args[2] === 'fix') await assertFixHasNewCommit(store, ticketId, defaultGitRunner);
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

/**
 * The same contract over an SSH remote (D556): the fake `ssh` binary makes the
 * "remote" a local tree, so `tail -F`, the upload and `emit-marker` really run.
 * The forwarder copies the remote events into the HOST bridge, the unchanged
 * poller/verifier/sink decides, and `mirrorToRemote` puts the reply where the
 * remote emitter reads it.
 */
interface SshRig {
  readonly store: Store;
  readonly ticketId: number;
  readonly wt: string;
  readonly remoteRepo: string;
  readonly paths: BridgePaths;
  readonly remote: RemoteDef;
  readonly remoteRunDir: string;
  readonly fake: FakeSshBin;
  readonly sshProc: SshProcess;
  readonly instruction: string;
  attach(runMarker?: MarkerRunner, onAck?: (ref: string) => void): BridgeAttachment;
  writeBrief(ref: string, body: string): Promise<void>;
  runRemote(script: string): Promise<{ code: number; stdout: string; stderr: string }>;
  runRemoteMarker(): Promise<{ code: number; stdout: string; stderr: string }>;
  stop(): Promise<void>;
}

let sshN = 0;
const sshCleanups: Array<() => Promise<void> | void> = [];

async function sshRig(stage: MarkerStage): Promise<SshRig> {
  const dir = join(root, `ssh-${String(++sshN)}`);
  const fake = await makeFakeSshBin();
  const trustDir = join(dir, 'trust');
  const remoteDir = join(fake.remoteRoot, 'srv', 'karst');
  const wt = join(dir, 'wt');
  mkdirSync(trustDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'feat', wt]);
  git(wt, ...ID, 'commit', '-q', '--allow-empty', '-m', 'base');

  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'K-1', title: 't' }).id;
  store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'app', ?, 'feat', 'main', 'inherited')").run(ticketId, wt);
  setStageCurrent(store, ticketId, stage as StageKey);

  const remote: RemoteDef = { host: 'fake', user: 'karst', mode: 'direct', remoteDir };
  const name = `karst-0123abcd-${String(ticketId)}-claude`;
  const ws = join(remoteDir, name);
  const remoteRepo = join(ws, 'repo');
  mkdirSync(remoteDir, { recursive: true });
  execFileSync('git', ['clone', '-q', '--no-hardlinks', wt, remoteRepo]);

  const controlDir = join(dir, 'control');
  mkdirSync(controlDir, { recursive: true });
  await recordRemoteTrust(trustDir, 'devbox', remote);

  const bridgeRoot = join(dir, 'bridge');
  const paths = bridgePaths(bridgeRoot, ticketId);
  await ensureBridgeDir(paths);
  writeBridgeScripts(join(paths.dir, 'claude'));
  const sshProc = createNodeSshProcess({ sshBin: fake.ssh });
  const remoteRunDir = `${ws}/bridge/${String(ticketId)}`;
  const upload = await uploadBridgeScripts({
    ssh: sshProc, remote, remoteName: 'devbox', core: 'claude', hostBridgeDir: paths.dir, runDir: remoteRunDir,
    trustDir, controlDir, ensureControlDir: () => Promise.resolve({ ok: true }),
  });
  if (!upload.ok) throw new Error(upload.reason);

  const instruction = renderSandboxMarkerInstruction({ runDir: remoteRunDir, core: 'claude', stage });
  const start = await startSshBridgeForwarder({
    ssh: sshProc, remote, remoteName: 'devbox', ws, ticketId,
    hostBridgeDir: paths.dir, stateDir: join(bridgeRoot, 'state'), trustDir, controlDir,
    ensureControlDir: () => Promise.resolve({ ok: true }),
  });
  if (!start.ok) throw new Error(start.reason);

  const realMarker: MarkerRunner = createMarkerRunner(
    {
      nodePath: process.execPath, cliEntry: 'cli.js', dbPath: 'db', manifestPath: 'm.yml', ticketKey: 'K-1', cwd: wt,
      ensureSynced: async () => {
        try {
          git(wt, 'fetch', '-q', remoteRepo, 'feat');
          git(wt, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err), diverged: false };
        }
      },
    },
    async (_cmd, args) => {
      try {
        if (args[2] === 'fix') await assertFixHasNewCommit(store, ticketId, defaultGitRunner);
        runStageCommand(store, ticketId, [args[1]!, args[2]!, args[3]!]);
        return { stdout: '', stderr: '', exitCode: 0 };
      } catch (err) {
        return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
      }
    },
  );

  const attachments: BridgeAttachment[] = [];
  const rig: SshRig = {
    store, ticketId, wt, remoteRepo, paths, remote, remoteRunDir, fake, sshProc, instruction,
    attach: (runMarker = realMarker, onAck) => {
      const attachment = createBridgeAttachment({
        paths,
        expect: { ticketId, worktreePath: wt, launchId: undefined, stage: () => getTicket(store, ticketId).stageCurrent as StageKey | null, sessionId: () => undefined, sessionLaunchId: () => undefined },
        dispatch: () => undefined,
        runMarker,
        ...(onAck ? { onAck } : {}),
        intervalMs: 20,
        mirrorReply: (seq, reply) => mirrorToRemote(
          { name: 'devbox', def: remote }, remoteRunDir, `results/${seq}.json`, JSON.stringify(reply),
          { trustDir, ssh: sshProc, controlDir, ensureControlDir: () => Promise.resolve({ ok: true }) },
        ),
      });
      attachment.start();
      attachments.push(attachment);
      return attachment;
    },
    writeBrief: async (ref, body) => {
      writeInboxFile(paths, ref, body);
      const mirrored = await mirrorToRemote(
        { name: 'devbox', def: remote }, remoteRunDir, `inbox/${ref}.md`, body,
        { trustDir, ssh: sshProc, controlDir, ensureControlDir: () => Promise.resolve({ ok: true }) },
      );
      if (!mirrored.ok) throw new Error(mirrored.reason);
    },
    runRemote: (script) => new Promise((resolve) => {
      const child = spawn(fake.ssh, sshArgv(remote, controlDir, script), { cwd: fake.remoteRoot, env: { ...process.env, KARST_MARKER_WAIT_MS: '20000' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    }),
    runRemoteMarker: () => {
      const command = /`(node [^`]+emit-marker\.cjs[^`]+)`/.exec(instruction)?.[1];
      if (!command) throw new Error('no marker command in the rendered instruction');
      return rig.runRemote(`cd ${sshQuote(remoteRepo)} && ${command}`);
    },
    stop: async () => {
      for (const a of attachments) await a.stop();
      store.close();
      await fake.cleanup();
    },
  };
  sshCleanups.push(rig.stop);
  return rig;
}

afterEach(async () => {
  await stopAllSshBridgeForwarders();
  while (sshCleanups.length > 0) await sshCleanups.pop()!();
});

describe('ssh stage contract (D556)', () => {
  it('a marker written remotely reaches the host, advances the stage, and the reply arrives remotely (exit 0)', async () => {
    const r = await sshRig('impl');
    r.attach();
    // The stub agent commits remotely (as it would in the remote clone).
    writeFileSync(join(r.remoteRepo, 'work.txt'), 'agent work');
    git(r.remoteRepo, 'add', '-A');
    git(r.remoteRepo, ...ID, 'commit', '-q', '-m', 'agent work');
    const out = await r.runRemoteMarker();
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('accepted');
    expect(getTicket(r.store, r.ticketId).stageCurrent).toBe(STAGE_GRAPH.impl.passed);
    const lines = readFileSync(r.paths.eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: 'marker', stage: 'impl' });
    const seq = String(lines[0]!['seq']);
    expect(JSON.parse(readFileSync(join(r.remoteRunDir, 'results', `${seq}.json`), 'utf8'))).toMatchObject({ ok: true, stage: 'impl' });
  }, 40_000);

  it('exit 1: a permanent host refusal is mirrored to the remote emitter', async () => {
    const r = await sshRig('impl');
    r.attach(async () => ({ code: 1, stderr: 'karst: cannot mark this stage done: no repository has changes' }));
    const out = await r.runRemoteMarker();
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('no repository has changes');
  }, 40_000);

  it('exit 3: a transient host failure is queued ("retrying") and mirrored to the remote emitter', async () => {
    const r = await sshRig('impl');
    r.attach(async () => ({ code: 1, stderr: 'sync failed: net down', transient: true }));
    const out = await r.runRemoteMarker();
    expect(out.code).toBe(3);
    expect(out.stdout).toContain('queued');
    expect(getTicket(r.store, r.ticketId).stageCurrent).toBe('impl');
  }, 40_000);

  it('a fix brief is delivered remotely, and its ack travels back over the forwarder', async () => {
    const r = await sshRig('fix');
    const acked: string[] = [];
    r.attach(undefined, (ref) => acked.push(ref));
    await r.writeBrief('fix-1', '# Fix brief\n\nplease fix it\n');
    expect(readFileSync(join(r.remoteRunDir, 'inbox', 'fix-1.md'), 'utf8')).toContain('please fix it');
    const ack = await r.runRemote(`cd ${sshQuote(r.remoteRepo)} && node ${sshQuote(`${r.remoteRunDir}/claude/emit-ack.cjs`)} ${sshQuote(`${r.remoteRunDir}/events.ndjson`)} fix-1`);
    expect(ack.code).toBe(0);
    for (let i = 0; i < 200 && acked.length === 0; i++) await new Promise((res) => setTimeout(res, 25));
    expect(acked).toEqual(['fix-1']);
  }, 40_000);
});

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

  it('fix: a marker after sync with no new commit since the round opened exits 1 with ok:false', async () => {
    const r = await prepare('fix');
    const round = openRecoveryRound(r.store, {
      ticketId: r.ticketId, sourceStage: 'uat', sourceProcessId: 'gates', triggerKind: 'gate-failure',
      triggerDetail: 'x', maxRounds: 3, startedAt: '2026-01-01T00:00:00Z',
    } as never);
    await snapshotFixRoundHeads(r.store, r.ticketId, round.id, defaultGitRunner);
    r.attach();
    const out = await r.runMarkerCommand();
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(NO_NEW_COMMIT_REASON);
    expect(getTicket(r.store, r.ticketId).stageCurrent).toBe('fix');
    const reply = readFileSync(join(r.paths.resultsDir, `${String(events(r.paths)[0]!['seq'])}.json`), 'utf8');
    expect(JSON.parse(reply)).toMatchObject({ ok: false, stage: 'fix', retrying: false });
    expect(JSON.parse(reply).reason).toContain(NO_NEW_COMMIT_REASON);
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

