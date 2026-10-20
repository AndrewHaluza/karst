import { mkdtempSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HOST_SESSION_RUNNER } from '../sessionRunner.js';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { createSbxSessionRunner, MAX_BUNDLE_STDOUT_BYTES, sandboxRemote } from './sbxRunner.js';

const NAME = 'karst-ab12cd34-7-claude';
const spec = (args: string[] = []) => ({
  ticketId: 7,
  hostWorktreePath: '/wt/with space',
  command: 'claude',
  args,
  env: { KARST_TICKET: '7' },
});
const ticket = { hostWorktreePath: '/wt/a', branch: 'feat/x' };

describe('createSbxSessionRunner.placeInteractive', () => {
  it('creates a fresh claude sandbox in clone mode, path as one element', () => {
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [] });
    expect(runner.kind).toBe('sbx');
    expect(runner.enforcesSandbox).toBe(true);
    const placed = runner.placeInteractive(spec(['--model', 'opus', '--resume', 'abc']));
    expect(placed).toEqual({
      cwd: '/wt/with space',
      shellPath: 'sbx',
      shellArgs: [
        'run', '--clone', '--name', NAME, 'claude', '/wt/with space',
        '--', '--dangerously-skip-permissions', '--model', 'opus', '--resume', 'abc',
      ],
      env: { KARST_TICKET: '7' },
    });
    expect(placed.shellArgs).not.toContain('--mount-docker-socket');
  });

  it('creates a fresh codex sandbox with its effort args after --', () => {
    const name = 'karst-ab12cd34-7-codex';
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'codex', name, existing: [] });
    expect(runner.placeInteractive(spec(['--config', 'model_reasoning_effort=high'])).shellArgs).toEqual([
      'run', '--clone', '--name', name, 'codex', '/wt/with space',
      '--', '--dangerously-bypass-approvals-and-sandbox', '--config', 'model_reasoning_effort=high',
    ]);
  });

  it('reattaches by name only when sbx ls reported the sandbox', () => {
    const reattach = ['run', '--name', NAME, 'claude', '--', '--dangerously-skip-permissions'];
    const existing = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [NAME] });
    expect(existing.placeInteractive(spec()).shellArgs).toEqual(reattach);
  });

  it('keeps --clone on a retry when the first launch never created the sandbox', () => {
    const fresh = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: ['other'] });
    fresh.placeInteractive(spec());
    expect(fresh.placeInteractive(spec()).shellArgs).toEqual([
      'run', '--clone', '--name', NAME, 'claude', '/wt/with space', '--', '--dangerously-skip-permissions',
    ]);
  });
});

describe('createSbxSessionRunner.runHeadless', () => {
  it('runs via sbx exec and passes exit code and abort signal through', async () => {
    const result = { stdout: 'o', stderr: '', exitCode: 3 };
    const spawnHeadless = vi.fn().mockResolvedValue(result);
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'codex', name: NAME, existing: [], spawnHeadless });
    const signal = new AbortController().signal;
    await expect(runner.runHeadless('codex', ['exec', 'hi there'], '/wt/a', { signal })).resolves.toBe(result);
    expect(spawnHeadless).toHaveBeenCalledWith('sbx', ['exec', NAME, '--', 'codex', 'exec', 'hi there'], '/wt/a', { signal });
  });
});

const G = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never -c protocol.file.allow=always -C /wt/a';
const BUNDLE_B64 = Buffer.from('bundle').toString('base64');
const EXEC = `sbx exec ${NAME} --`;
const text = (c: { command: string; args: readonly string[] }) => [c.command, ...c.args].join(' ');

describe('createSbxSessionRunner.sync', () => {
  it('bundles inside the sandbox, fetches that bundle, then fast-forwards (no git in the clone)', async () => {
    const proc = fakeSbxProcess({ [EXEC]: { stdout: BUNDLE_B64 } });
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [], cloneDir: '/p/clone' });
    await expect(runner.sync!(ticket)).resolves.toEqual({ ok: true, summary: "fast-forwarded feat/x to the sbx sandbox's commits" });
    const lines = proc.calls.map(text);
    expect(lines[0]).toMatch(new RegExp(`^${EXEC} sh -c .*bundle create.* karst-bundle feat/x$`));
    expect(proc.calls[0]!.opts).toEqual({ cwd: '/p/clone', maxStdoutBytes: MAX_BUNDLE_STDOUT_BYTES });
    expect(lines[1]).toMatch(new RegExp(`^${G} fetch \\S+/out\\.bundle refs/heads/feat/x$`));
    expect(lines.slice(2)).toEqual([`${G} merge-base --is-ancestor HEAD FETCH_HEAD`, `${G} merge --ff-only FETCH_HEAD`]);
    expect(proc.calls.every((c) => c.command !== 'git' || (c.opts?.env?.GIT_CONFIG_GLOBAL === '/dev/null' && c.opts.env.GIT_CONFIG_NOSYSTEM === '1'))).toBe(true);
    expect(lines.some((l) => l.includes('/p/clone') && l.startsWith('git'))).toBe(false);
  });

  it('refuses a non-fast-forward and never merges', async () => {
    const proc = fakeSbxProcess({ [EXEC]: { stdout: BUNDLE_B64 }, [`${G} merge-base`]: { code: 1 } });
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] });
    const out = await runner.sync!(ticket);
    expect(out).toEqual({ ok: false, reason: expect.stringMatching(/not a fast-forward.*never forced/) });
    expect(proc.calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('reports a failed bundle, an empty bundle, a failed fetch and a failed merge', async () => {
    const make = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) =>
      createSbxSessionRunner({ proc: fakeSbxProcess(answers), core: 'claude', name: NAME, existing: [] }).sync!(ticket);
    await expect(make({ [EXEC]: { code: 1, stderr: 'no repo\n' } })).resolves.toEqual({ ok: false, reason: 'no sandbox clone to sync from: no repo' });
    await expect(make({ [EXEC]: { stdout: '' } })).resolves.toEqual({ ok: false, reason: 'sandbox returned an empty bundle' });
    await expect(make({ [EXEC]: { stdout: BUNDLE_B64 }, [`${G} fetch`]: { code: 1, stderr: 'bad\n' } }))
      .resolves.toEqual({ ok: false, reason: 'git fetch of the sandbox bundle failed: bad' });
    await expect(make({ [EXEC]: { stdout: BUNDLE_B64 }, [`${G} merge --ff-only`]: { code: 1, stderr: 'dirty\n' } }))
      .resolves.toEqual({ ok: false, reason: 'git merge --ff-only FETCH_HEAD failed: dirty' });
  });
});

describe('createSbxSessionRunner.diff', () => {
  it('fetches the sandbox bundle and diffs the host branch against it, never merging', async () => {
    const proc = fakeSbxProcess({ [EXEC]: { stdout: BUNDLE_B64 }, [`${G} diff HEAD...FETCH_HEAD`]: { stdout: 'diff --git a/f b/f\n' } });
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] });
    await expect(runner.diff!(ticket)).resolves.toEqual({ ok: true, diff: 'diff --git a/f b/f\n', ref: 'FETCH_HEAD' });
    expect(proc.calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('reports a failed bundle and a failed diff', async () => {
    const make = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) =>
      createSbxSessionRunner({ proc: fakeSbxProcess(answers), core: 'claude', name: NAME, existing: [] }).diff!(ticket);
    await expect(make({ [EXEC]: { code: 2, stderr: 'gone\n' } })).resolves.toEqual({ ok: false, reason: 'no sandbox clone to sync from: gone' });
    await expect(make({ [EXEC]: { stdout: BUNDLE_B64 }, [`${G} diff`]: { code: 128, stderr: 'bad rev\n' } }))
      .resolves.toEqual({ ok: false, reason: 'git diff failed: bad rev' });
  });
});

describe('createSbxSessionRunner.dispose', () => {
  it('targets exactly its own name and leaves a bystander alone', async () => {
    const proc = fakeSbxProcess();
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [NAME, 'bystander'] });
    await runner.dispose!(ticket);
    expect(proc.calls.map((c) => [c.command, ...c.args].join(' '))).toEqual([
      `sbx stop ${NAME}`,
      `sbx rm --force ${NAME}`,
      `${G} remote remove ${sandboxRemote(NAME)}`,
    ]);
    expect(proc.calls.some((c) => c.args.includes('bystander'))).toBe(false);
    // Disposed: the next launch creates again.
    expect(runner.placeInteractive(spec()).shellArgs).toContain('--clone');
  });
});

describe('createSbxSessionRunner.stop', () => {
  it('stops only its own sandbox and keeps it known for reattach', async () => {
    const proc = fakeSbxProcess();
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [NAME] });
    await runner.stop!();
    expect(proc.calls.map((c) => [c.command, ...c.args].join(' '))).toEqual([`sbx stop ${NAME}`]);
    expect(runner.placeInteractive(spec()).shellArgs).not.toContain('--clone');
  });
});

describe('createSbxSessionRunner bridge dir', () => {
  it('creates with the bridge dir as the single extra workspace', () => {
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [] });
    expect(runner.placeInteractive({ ...spec(), bridgeDir: '/g/events/7' }).shellArgs).toEqual([
      'run', '--clone', '--name', NAME, 'claude', '/wt/with space', '/g/events/7', '--', '--dangerously-skip-permissions',
    ]);
  });
  it('does not re-pass the bridge dir when reattaching', () => {
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [NAME] });
    expect(runner.placeInteractive({ ...spec(), bridgeDir: '/g/events/7' }).shellArgs.join(' ')).not.toContain('/g/events/7');
  });
  it('the agent sees the bridge dir at its host path', () => {
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [] });
    const paths = { dir: '/g/events/7', eventsFile: '/g/events/7/events.ndjson', stateFile: '/g/state/7.json', resultsDir: '/g/events/7/results', inboxDir: '/g/events/7/inbox', pendingFile: '/g/state/7.marker.json', handledFile: '/g/state/7.handled.json', runDir: '/karst-bridge/7' };
    expect(runner.bridgeRunDir?.(paths)).toBe('/g/events/7');
  });
});

describe('createSbxSessionRunner cloneDir', () => {
  const cloneDir = '/p/.karst/sbx-clones/' + NAME;
  it('uses the standalone clone, never the worktree, as the --clone source', () => {
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [], cloneDir });
    const placed = runner.placeInteractive(spec());
    expect(placed.shellArgs).toContain(cloneDir);
    expect(placed.shellArgs).not.toContain('/wt/with space');
    expect(placed.cwd).toBe(cloneDir);
  });
});

describe('createSbxSessionRunner env (F2, arch:AC-33)', () => {
  it('drops host-path vars, keeps the bridge dir and ids', () => {
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'codex', name: NAME, existing: [] });
    const placed = runner.placeInteractive({
      ...spec(),
      env: { KARST_CLI: '/h/cli.js', KARST_DB: '/h/db', KARST_MANIFEST: '/h/m.yml', KARST_INSTRUCTIONS: '/h/i.md', KARST_BRIDGE_DIR: '/b/7', KARST_TICKET_ID: '7' },
    });
    expect(placed.env).toEqual({ KARST_BRIDGE_DIR: '/b/7', KARST_TICKET_ID: '7' });
  });
});

describe('createSbxSessionRunner.refresh', () => {
  const G = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never -c protocol.file.allow=always -C /wt/a';
  /** The fake host git creates no file: write the bundle it was asked for. */
  const withBundleFile = (a: Parameters<typeof fakeSbxProcess>[0] = {}) => {
    const inner = fakeSbxProcess(a);
    return {
      calls: inner.calls,
      run: async (c: string, args: readonly string[], o?: Parameters<typeof inner.run>[2]) => {
        const r = await inner.run(c, args, o);
        if (c === 'git' && args.includes('bundle') && r.code === 0) writeFileSync(args[args.indexOf('-q') + 1]!, 'b');
        return r;
      },
    };
  };
  it('bundles the host branch into xfer/ and lets the sandbox fetch it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-refresh-'));
    const proc = withBundleFile();
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [], cloneDir: '/p/clone', evidenceDir: dir });
    await expect(runner.refresh!(ticket)).resolves.toEqual({ ok: true, summary: 'refreshed the sandbox clone of feat/x from the host' });
    const lines = proc.calls.map(text);
    expect(lines[0]).toContain(`${G} bundle create -q ${dir}/xfer/in.bundle feat/x`);
    expect(lines[1]).toMatch(new RegExp(`^${EXEC} sh -c [\\s\\S]* karst-refresh feat/x ${dir}/xfer/in.bundle$`));
    expect(proc.calls[1]!.opts).toEqual({ cwd: '/p/clone' });
    expect(lines.some((l) => l.startsWith('git') && l.includes('/p/clone'))).toBe(false);
  });
  it('recreates a symlinked xfer/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-refresh-'));
    symlinkSync(tmpdir(), join(dir, 'xfer'));
    const runner = createSbxSessionRunner({ proc: withBundleFile(), core: 'claude', name: NAME, existing: [], evidenceDir: dir });
    await runner.refresh!(ticket);
    expect(lstatSync(join(dir, 'xfer')).isSymbolicLink()).toBe(false);
  });
  it('reports dirty, diverged and a failed bundle; needs a bridge dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-refresh-'));
    const mk = (a: Parameters<typeof fakeSbxProcess>[0]) => createSbxSessionRunner({ proc: withBundleFile(a), core: 'claude', name: NAME, existing: [], evidenceDir: dir });
    expect(await mk({ [EXEC]: { code: 3, stdout: ' M a\n' } }).refresh!(ticket)).toMatchObject({ ok: false, reason: expect.stringContaining('uncommitted work') });
    expect(await mk({ [EXEC]: { code: 4 } }).refresh!(ticket)).toMatchObject({ ok: false, reason: expect.stringContaining('diverged') });
    expect(await mk({ [`${G} bundle`]: { code: 1, stderr: 'bad' } }).refresh!(ticket)).toEqual({ ok: false, reason: 'git bundle create feat/x failed: bad' });
    expect(await createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [] }).refresh!(ticket)).toMatchObject({ ok: false });
  });
});
