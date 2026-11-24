import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, setPlanningSessionStatus } from '../../store/planningSessions.js';
import {
  PLANNING_ARCHIVED_DIR_MAX_BYTES,
  prunePlanningScratch,
  removeScratchDir,
  type PrunedPlanningDir,
} from './planningScratchRetention.js';

const MB = 1024 * 1024;
const NOW = new Date('2026-10-24T12:00:00Z');
const PAST = '2026-10-20 12:00:00'; // 4 days idle, past the default 3-day delay
const INSIDE = '2026-10-23 12:00:00'; // 1 day idle
const AT_CUTOFF = '2026-10-21 12:00:00'; // exactly 3 days idle

/** Sparse file: instant on disk, real logical size for the size walk. */
function sparse(path: string, bytes: number): void {
  writeFileSync(path, '');
  truncateSync(path, bytes);
}

describe('prunePlanningScratch', () => {
  let store: Store;
  let projectId: number;
  let root: string;
  let scratchRoot: string;
  let debug: string[];

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    root = mkdtempSync(join(tmpdir(), 'karst-plan-retention-'));
    scratchRoot = root;
    debug = [];
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const touch = (id: number, at: string): void => {
    store.db.prepare('UPDATE planning_sessions SET updated_at = ? WHERE id = ?').run(at, id);
  };

  const session = (status: 'active' | 'filed' | 'archived' = 'archived', at = PAST): number => {
    const id = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: null }).id;
    if (status !== 'active') setPlanningSessionStatus(store, id, status);
    touch(id, at);
    return id;
  };

  const artifacts = (id: number): string => join(scratchRoot, String(id), 'artifacts');

  const run = (
    opts: Partial<Parameters<typeof prunePlanningScratch>[0]> = {},
  ): Promise<PrunedPlanningDir[]> =>
    prunePlanningScratch({
      store,
      projectId,
      scratchRoot,
      afterDays: 3,
      now: NOW,
      isLive: () => false,
      debug: (m) => debug.push(m),
      ...opts,
    });

  it('exports a 50 MB threshold', async () => {
    expect(PLANNING_ARCHIVED_DIR_MAX_BYTES).toBe(50 * MB);
  });

  it('removes a large nested sub-dir of an archived session past the delay and keeps the plans', async () => {
    const id = session();
    const dir = artifacts(id);
    mkdirSync(join(dir, 'spike', 'repo', 'node_modules'), { recursive: true });
    sparse(join(dir, 'spike', 'repo', 'node_modules', 'a.bin'), 40 * MB);
    sparse(join(dir, 'spike', 'repo', 'b.bin'), 20 * MB);
    mkdirSync(join(dir, 'notes'), { recursive: true });
    sparse(join(dir, 'notes', 'small.md'), 1 * MB);
    sparse(join(dir, 'plan.md'), 4);
    sparse(join(dir, 'draft.json'), 8);
    sparse(join(dir, 'big-screenshot.png'), 60 * MB);
    // Sibling scratch entries outside artifacts/.
    mkdirSync(join(scratchRoot, String(id), 'outbox'), { recursive: true });
    sparse(join(scratchRoot, String(id), 'outbox', 'x.json'), 4);
    sparse(join(scratchRoot, String(id), 'proposals.json'), 4);
    sparse(join(scratchRoot, String(id), 'karst-instructions.md'), 4);

    expect(await run()).toEqual([{ sessionId: id, dir: 'spike', bytes: 60 * MB }]);
    expect(existsSync(join(dir, 'spike'))).toBe(false);
    expect(existsSync(join(dir, 'notes', 'small.md'))).toBe(true);
    expect(existsSync(join(dir, 'plan.md'))).toBe(true);
    expect(existsSync(join(dir, 'draft.json'))).toBe(true);
    expect(existsSync(join(dir, 'big-screenshot.png'))).toBe(true);
    expect(existsSync(join(scratchRoot, String(id), 'outbox', 'x.json'))).toBe(true);
    expect(existsSync(join(scratchRoot, String(id), 'proposals.json'))).toBe(true);
    expect(existsSync(join(scratchRoot, String(id), 'karst-instructions.md'))).toBe(true);
    expect(debug.some((m) => m.includes('removed spike'))).toBe(true);
    // Top-level files are skipped without ever being sized (sizing a file throws).
    expect(debug.filter((m) => m.includes('failed on session'))).toEqual([]);
  });

  it('keeps a directory at exactly the threshold and removes one byte over', async () => {
    const id = session();
    const dir = artifacts(id);
    mkdirSync(join(dir, 'exact'), { recursive: true });
    sparse(join(dir, 'exact', 'f.bin'), PLANNING_ARCHIVED_DIR_MAX_BYTES);
    mkdirSync(join(dir, 'over'), { recursive: true });
    sparse(join(dir, 'over', 'f.bin'), PLANNING_ARCHIVED_DIR_MAX_BYTES + 1);

    expect(await run()).toEqual([
      { sessionId: id, dir: 'over', bytes: PLANNING_ARCHIVED_DIR_MAX_BYTES + 1 },
    ]);
    expect(existsSync(join(dir, 'exact', 'f.bin'))).toBe(true);
    expect(existsSync(join(dir, 'over'))).toBe(false);
  });

  it('leaves an archived session inside the delay untouched', async () => {
    const id = session('archived', INSIDE);
    const dir = artifacts(id);
    mkdirSync(join(dir, 'spike'), { recursive: true });
    sparse(join(dir, 'spike', 'f.bin'), 60 * MB);

    expect(await run()).toEqual([]);
    expect(existsSync(join(dir, 'spike', 'f.bin'))).toBe(true);
  });

  it('prunes exactly at the cutoff and keeps a session one second inside it', async () => {
    const atCutoff = session('archived', AT_CUTOFF);
    mkdirSync(join(artifacts(atCutoff), 'spike'), { recursive: true });
    sparse(join(artifacts(atCutoff), 'spike', 'f.bin'), 60 * MB);
    const newer = session('archived', '2026-10-21 12:00:01');
    mkdirSync(join(artifacts(newer), 'spike'), { recursive: true });
    sparse(join(artifacts(newer), 'spike', 'f.bin'), 60 * MB);

    expect(await run()).toEqual([{ sessionId: atCutoff, dir: 'spike', bytes: 60 * MB }]);
    expect(existsSync(join(artifacts(newer), 'spike', 'f.bin'))).toBe(true);
  });

  it('honours a custom afterDays', async () => {
    const id = session('archived', INSIDE);
    mkdirSync(join(artifacts(id), 'spike'), { recursive: true });
    sparse(join(artifacts(id), 'spike', 'f.bin'), 60 * MB);

    expect(await run({ afterDays: 0 })).toEqual([{ sessionId: id, dir: 'spike', bytes: 60 * MB }]);
  });

  it('never touches active or filed sessions', async () => {
    const active = session('active');
    const filed = session('filed');
    for (const id of [active, filed]) {
      mkdirSync(join(artifacts(id), 'spike'), { recursive: true });
      sparse(join(artifacts(id), 'spike', 'f.bin'), 60 * MB);
    }

    expect(await run()).toEqual([]);
    expect(existsSync(join(artifacts(active), 'spike', 'f.bin'))).toBe(true);
    expect(existsSync(join(artifacts(filed), 'spike', 'f.bin'))).toBe(true);
  });

  it('never touches an archived session with a live terminal', async () => {
    const id = session();
    mkdirSync(join(artifacts(id), 'spike'), { recursive: true });
    sparse(join(artifacts(id), 'spike', 'f.bin'), 60 * MB);

    expect(await run({ isLive: (s) => s === id })).toEqual([]);
    expect(existsSync(join(artifacts(id), 'spike', 'f.bin'))).toBe(true);
  });

  it('never touches another project’s archived session', async () => {
    const other = upsertProject(store, { slug: 'q' }).id;
    const id = session('archived');
    store.db.prepare('UPDATE planning_sessions SET project_id = ? WHERE id = ?').run(other, id);
    mkdirSync(join(artifacts(id), 'spike'), { recursive: true });
    sparse(join(artifacts(id), 'spike', 'f.bin'), 60 * MB);

    expect(await run()).toEqual([]);
    expect(existsSync(join(artifacts(id), 'spike', 'f.bin'))).toBe(true);
  });

  it('skips a symlinked directory and never follows it', async () => {
    const id = session();
    const dir = artifacts(id);
    mkdirSync(dir, { recursive: true });
    const external = join(root, 'external');
    mkdirSync(external, { recursive: true });
    sparse(join(external, 'f.bin'), 60 * MB);
    symlinkSync(external, join(dir, 'link'), 'dir');

    expect(await run()).toEqual([]);
    expect(lstatSync(join(dir, 'link')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(external, 'f.bin'))).toBe(true);
  });

  it('refuses a symlinked artifacts dir so a delete never leaves the scratch root', async () => {
    const id = session();
    const sessionDir = join(scratchRoot, String(id));
    mkdirSync(sessionDir, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'karst-plan-outside-'));
    try {
      mkdirSync(join(outside, 'spike'), { recursive: true });
      sparse(join(outside, 'spike', 'f.bin'), 60 * MB);
      symlinkSync(outside, join(sessionDir, 'artifacts'), 'dir');

      expect(await run()).toEqual([]);
      expect(existsSync(join(outside, 'spike', 'f.bin'))).toBe(true);
      expect(debug.some((m) => m.includes('refusing symlinked artifacts dir'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked session dir as well', async () => {
    const id = session();
    const outside = mkdtempSync(join(tmpdir(), 'karst-plan-session-'));
    try {
      mkdirSync(join(outside, 'artifacts', 'spike'), { recursive: true });
      sparse(join(outside, 'artifacts', 'spike', 'f.bin'), 60 * MB);
      symlinkSync(outside, join(scratchRoot, String(id)), 'dir');

      expect(await run()).toEqual([]);
      expect(existsSync(join(outside, 'artifacts', 'spike', 'f.bin'))).toBe(true);
      expect(debug.some((m) => m.includes('refusing symlinked artifacts dir'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not follow a nested symlink while sizing a small dir', async () => {
    const id = session();
    const dir = artifacts(id);
    mkdirSync(join(dir, 'small'), { recursive: true });
    sparse(join(dir, 'small', 'real.md'), 1 * MB);
    const external = join(root, 'external');
    mkdirSync(external, { recursive: true });
    sparse(join(external, 'f.bin'), 60 * MB);
    symlinkSync(external, join(dir, 'small', 'link'), 'dir');

    expect(await run()).toEqual([]);
    expect(existsSync(join(dir, 'small', 'real.md'))).toBe(true);
    expect(existsSync(join(external, 'f.bin'))).toBe(true);
  });

  it('skips a missing artifacts dir without logging an error', async () => {
    session();

    expect(await run()).toEqual([]);
    expect(debug).toEqual([]);
  });

  it('logs a non-ENOENT read error and moves on', async () => {
    const id = session();
    // `artifacts` as a file makes readdirSync throw ENOTDIR.
    mkdirSync(join(scratchRoot, String(id)), { recursive: true });
    writeFileSync(join(scratchRoot, String(id), 'artifacts'), '');

    expect(await run()).toEqual([]);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('failed to read');
    expect(debug[0]).toContain('ENOTDIR');
  });

  it('removeScratchDir tolerates a directory that is already gone', async () => {
    await expect(removeScratchDir(join(root, 'gone'))).resolves.toBeUndefined();
  });

  it('logs a per-dir removal error and still prunes the remaining dirs and sessions', async () => {
    const first = session();
    const second = session();
    for (const id of [first, second]) {
      mkdirSync(join(artifacts(id), 'boom'), { recursive: true });
      sparse(join(artifacts(id), 'boom', 'f.bin'), 60 * MB);
      mkdirSync(join(artifacts(id), 'ok'), { recursive: true });
      sparse(join(artifacts(id), 'ok', 'f.bin'), 60 * MB);
    }

    const pruned = await run({
      removeDir: (path) => {
        if (path.endsWith('boom')) throw new Error('EACCES: denied');
        rmSync(path, { recursive: true, force: true });
      },
    });

    expect(pruned.map((p) => `${p.sessionId}:${p.dir}`).sort()).toEqual(
      [`${first}:ok`, `${second}:ok`].sort(),
    );
    const failures = debug.filter((m) => m.includes('failed on session'));
    expect(failures).toHaveLength(2);
    // The thrown message survives into the log (not `undefined`).
    expect(failures.every((m) => m.includes('EACCES: denied'))).toBe(true);
    expect(existsSync(join(artifacts(first), 'boom', 'f.bin'))).toBe(true);
    expect(existsSync(join(artifacts(second), 'boom', 'f.bin'))).toBe(true);
  });
});
