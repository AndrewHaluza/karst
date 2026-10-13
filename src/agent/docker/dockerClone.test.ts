import { describe, expect, it } from 'vitest';
import { chownVolumes, ensureClone, ensureVolume, syncFromClone, type TempDirs } from './dockerClone.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { dockerNames } from './dockerNames.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';

const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' });
const WT = '/w t';
const input = { hostWorktreePath: WT, branch: 'feat/x' };

function fakeTemp(): TempDirs & { removed: string[] } {
  const removed: string[] = [];
  return { removed, make: () => Promise.resolve('/tmp/k1'), remove: (p) => { removed.push(p); return Promise.resolve(); } };
}

const lines = (proc: ReturnType<typeof fakeDockerProcess>) => proc.calls.map((c) => [c.command, ...c.args].join(' '));
const ctx = (proc: ReturnType<typeof fakeDockerProcess>, temp = fakeTemp(), user?: { uid: number; gid: number }) =>
  ({ proc, names, user, temp });
const VOLS = `--mount type=volume,source=${names.repoVolume},target=/work --mount type=volume,source=${names.dataVolume},target=/home/node/.local/share/opencode`;

describe('ensureVolume', () => {
  it('keeps an existing volume', async () => {
    const proc = fakeDockerProcess();
    await expect(ensureVolume(proc, 'v')).resolves.toEqual({ ok: true, created: false });
    expect(lines(proc)).toEqual(['docker volume inspect v']);
  });
  it('creates a missing one', async () => {
    const proc = fakeDockerProcess({ 'docker volume inspect': { code: 1 } });
    await expect(ensureVolume(proc, 'v')).resolves.toEqual({ ok: true, created: true });
    expect(lines(proc)[1]).toBe('docker volume create v');
  });
  it('reports a failed create', async () => {
    const proc = fakeDockerProcess({ 'docker volume inspect': { code: 1 }, 'docker volume create': { code: 1, stderr: 'disk full' } });
    await expect(ensureVolume(proc, 'v')).resolves.toEqual({ ok: false, reason: 'docker volume create v failed: disk full' });
  });
});

describe('chownVolumes', () => {
  it('does nothing off linux', async () => {
    const proc = fakeDockerProcess();
    await expect(chownVolumes(ctx(proc))).resolves.toEqual({ ok: true });
    expect(proc.calls).toHaveLength(0);
  });
  it('chowns both volumes as root inside a throwaway container', async () => {
    const proc = fakeDockerProcess();
    await expect(chownVolumes(ctx(proc, fakeTemp(), { uid: 1001, gid: 1002 }))).resolves.toEqual({ ok: true });
    expect(lines(proc)).toEqual([
      `docker run --rm --network none --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges --user 0 ${VOLS} ${OPENCODE_IMAGE} chown 1001:1002 /work /home/node/.local/share/opencode`,
    ]);
  });
  it('reports a failed chown', async () => {
    const proc = fakeDockerProcess({ 'docker run': { code: 1, stderr: 'nope' } });
    await expect(chownVolumes(ctx(proc, fakeTemp(), { uid: 1, gid: 1 }))).resolves.toEqual({ ok: false, reason: 'docker volume chown failed: nope' });
  });
});

describe('ensureClone', () => {
  it('skips when the volume already holds a clone', async () => {
    const proc = fakeDockerProcess();
    await expect(ensureClone(ctx(proc), input)).resolves.toEqual({ ok: true });
    expect(lines(proc)).toEqual([`docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges ${VOLS} ${OPENCODE_IMAGE} git -C /work/repo rev-parse --git-dir`]);
  });

  it('bundles the branch on the host and clones it offline with the host identity', async () => {
    const temp = fakeTemp();
    const clone = `docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges ${VOLS} --mount type=bind,source=/tmp/k1,target=/bundle,readonly`;
    const answers = fakeDockerProcess({
      [`docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges ${VOLS} ${OPENCODE_IMAGE} git -C`]: { code: 128 },
      'git -C /w t config user.name': { stdout: 'Ann Dev\n' },
      'git -C /w t config user.email': { stdout: 'ann@x.io\n' },
    });
    await expect(ensureClone(ctx(answers, temp), input)).resolves.toEqual({ ok: true });
    expect(answers.calls.map((c) => c.args)).toContainEqual(['-C', WT, 'bundle', 'create', '/tmp/k1/in.bundle', 'feat/x']);
    expect(lines(answers).at(-1)).toBe(
      `${clone} ${OPENCODE_IMAGE} git clone --config user.name=Ann Dev --config user.email=ann@x.io --branch feat/x /bundle/in.bundle /work/repo`,
    );
    expect(answers.calls.at(-1)!.args).toContain('user.name=Ann Dev');
    expect(temp.removed).toEqual(['/tmp/k1']);
  });

  it('omits an unset identity', async () => {
    const proc = fakeDockerProcess({ [`docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges ${VOLS} ${OPENCODE_IMAGE} git -C`]: { code: 128 } });
    await ensureClone(ctx(proc), input);
    expect(lines(proc).at(-1)).not.toContain('--config');
  });

  it('runs the helpers as the linux user', async () => {
    const proc = fakeDockerProcess();
    await ensureClone(ctx(proc, fakeTemp(), { uid: 1001, gid: 1002 }), input);
    expect(lines(proc)[0]).toContain('--user 1001:1002');
  });

  it('reports a failed bundle and still removes the temp dir', async () => {
    const temp = fakeTemp();
    const proc = fakeDockerProcess({
      [`docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges ${VOLS} ${OPENCODE_IMAGE} git -C`]: { code: 128 },
      'git -C /w t bundle': { code: 128, stderr: 'fatal: bad ref' },
    });
    await expect(ensureClone(ctx(proc, temp), input)).resolves.toEqual({ ok: false, reason: 'git bundle create feat/x failed: fatal: bad ref' });
    expect(temp.removed).toEqual(['/tmp/k1']);
  });

  it('reports a failed clone', async () => {
    const proc = fakeDockerProcess({
      [`docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges ${VOLS} ${OPENCODE_IMAGE} git -C`]: { code: 128 },
      [`docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges ${VOLS} --mount`]: { code: 128, stderr: 'fatal: x' },
    });
    await expect(ensureClone(ctx(proc), input)).resolves.toEqual({ ok: false, reason: `clone into ${names.repoVolume} failed: fatal: x` });
  });
});

describe('syncFromClone', () => {
  const RO = `--mount type=volume,source=${names.repoVolume},target=/work,readonly --mount type=volume,source=${names.dataVolume},target=/home/node/.local/share/opencode`;

  it('bundles out of the read-only clone, fetches and fast-forwards', async () => {
    const temp = fakeTemp();
    const proc = fakeDockerProcess();
    await expect(syncFromClone(ctx(proc, temp), input)).resolves.toEqual({
      ok: true, summary: "fast-forwarded feat/x to the docker sandbox's commits",
    });
    expect(lines(proc)).toEqual([
      `docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges ${RO} --mount type=bind,source=/tmp/k1,target=/bundle ${OPENCODE_IMAGE} git -c safe.directory=* -C /work/repo bundle create /bundle/out.bundle feat/x`,
      'git -C /w t fetch /tmp/k1/out.bundle refs/heads/feat/x',
      'git -C /w t merge-base --is-ancestor HEAD FETCH_HEAD',
      'git -C /w t merge --ff-only FETCH_HEAD',
    ]);
    expect(temp.removed).toEqual(['/tmp/k1']);
  });

  it('refuses a non-fast-forward and never merges', async () => {
    const proc = fakeDockerProcess({ 'git -C /w t merge-base': { code: 1 } });
    const result = await syncFromClone(ctx(proc), input);
    expect(result).toEqual({ ok: false, reason: "refused: the sandbox's feat/x is not a fast-forward of the host branch (never forced)" });
    expect(lines(proc).some((l) => l.includes('merge --ff-only'))).toBe(false);
  });

  it('reports a missing clone', async () => {
    const proc = fakeDockerProcess({ 'docker run': { code: 128, stderr: 'not a git repository' } });
    await expect(syncFromClone(ctx(proc), input)).resolves.toEqual({ ok: false, reason: 'no sandbox clone to sync from: not a git repository' });
  });

  it('reports a failed fetch', async () => {
    const proc = fakeDockerProcess({ 'git -C /w t fetch': { code: 1, stderr: 'bad bundle' } });
    await expect(syncFromClone(ctx(proc), input)).resolves.toEqual({ ok: false, reason: 'git fetch of the sandbox bundle failed: bad bundle' });
  });

  it('reports a failed merge', async () => {
    const proc = fakeDockerProcess({ 'git -C /w t merge --ff-only': { code: 1, stderr: 'dirty tree' } });
    await expect(syncFromClone(ctx(proc), input)).resolves.toEqual({ ok: false, reason: 'git merge --ff-only failed: dirty tree' });
  });
});

describe('bind paths', () => {
  it('refuses a temp dir with a comma, and sync reports it instead of throwing', async () => {
    const temp = { removed: [], make: () => Promise.resolve('/tmp/a,b'), remove: () => Promise.resolve() };
    await expect(syncFromClone(ctx(fakeDockerProcess(), temp), input)).resolves.toEqual({
      ok: false, reason: 'docker sync failed: docker: unsafe bind path "/tmp/a,b"',
    });
  });
});
