import { appendFile, mkdir, readdir, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

import { snapshotBytes } from '../approaches/graph/artifacts/snapshot.js';
import { runGit, runGitText } from './gitRun.js';
import { KeyedQueue } from './queue.js';
import { DEFAULT_MAX_ARTIFACT_BYTES, isSafeTreePath, isSecretPath } from './skipRules.js';

const BRANCH = 'refs/heads/main';

export interface RevisionTrailers {
  session?: string;
  approach?: string;
  stage?: string;
  phase?: string;
  kind?: string;
  source?: string;
}

export type RevisionInput = {
  ticketId: number;
  /** Repository name; first segment of the tree path. */
  repo: string;
  /** Path relative to the repository root, `/`-separated. */
  relPath: string;
  trailers?: RevisionTrailers;
} & ({ sourcePath: string; deleted?: false } | { deleted: true; sourcePath?: undefined });

export interface SkipRecord {
  ticketId: number;
  path: string;
  reason: string;
  at: string;
}

export interface ArtifactSummary {
  path: string;
  revisions: number;
  latestSha: string;
}

export interface RevisionInfo {
  sha: string;
  at: string;
  trailers: Record<string, string>;
}

export interface ArtifactStoreOptions {
  /** `<globalStorage>/artifacts` — the store lives under `p<projectId>/<ticketId>/repo.git`. */
  artifactsRoot: string;
  projectId: number;
  maxBytes?: number;
  now?: () => Date;
}

export interface ArtifactStore {
  /** Commit sha, or null when skipped / unchanged. */
  commitRevision(input: RevisionInput): Promise<string | null>;
  listArtifacts(ticketId: number): Promise<ArtifactSummary[]>;
  history(ticketId: number, path: string): Promise<RevisionInfo[]>;
  show(ticketId: number, sha: string, path: string): Promise<Buffer>;
  diff(ticketId: number, a: string, b: string, path: string): Promise<string>;
  listSkips(ticketId: number): Promise<SkipRecord[]>;
  purgeArtifacts(ticketId: number): Promise<void>;
  /** Purge every ticket store whose newest revision is older than `maxAgeDays`; returns purged ticket ids. */
  purgeStale(maxAgeDays: number): Promise<number[]>;
}

/**
 * Ticket store dir. The `p` prefix keeps it clear of the numeric
 * `<ticketId>/` gate-log dirs that `reapOrphanedArtifactDirs` sweeps.
 */
export function ticketStoreDir(artifactsRoot: string, projectId: number, ticketId: number): string {
  return join(artifactsRoot, `p${projectId}`, String(ticketId));
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const clean = (v: string): string => v.replace(/[\r\n]+/g, ' ').trim();
const SHA = /^[0-9a-f]{40,64}$/;

interface TreeEntry { mode: string; sha: string }

/** True when a file at `path` would need a stored file to also be a directory, or the reverse. */
function treePathConflicts(files: ReadonlyMap<string, TreeEntry>, path: string): boolean {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (files.has(parts.slice(0, i).join('/'))) return true;
  }
  const asDir = `${path}/`;
  for (const existing of files.keys()) if (existing.startsWith(asDir)) return true;
  return false;
}

export function createArtifactStore(opts: ArtifactStoreOptions): ArtifactStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const now = opts.now ?? (() => new Date());
  const queue = new KeyedQueue();
  const dirOf = (ticketId: number): string => ticketStoreDir(opts.artifactsRoot, opts.projectId, ticketId);
  const gitDirOf = (ticketId: number): string => join(dirOf(ticketId), 'repo.git');
  const skipsFile = (ticketId: number): string => join(dirOf(ticketId), 'skips.jsonl');

  const recordSkip = async (ticketId: number, path: string, reason: string): Promise<void> => {
    await mkdir(dirOf(ticketId), { recursive: true });
    const rec: SkipRecord = { ticketId, path, reason, at: now().toISOString() };
    await appendFile(skipsFile(ticketId), `${JSON.stringify(rec)}\n`);
  };

  async function ensureRepo(ticketId: number): Promise<string> {
    const gitDir = gitDirOf(ticketId);
    if (!(await exists(join(gitDir, 'HEAD')))) {
      await mkdir(gitDir, { recursive: true });
      await runGit(gitDir, ['init', '--bare', '-q', '--initial-branch=main']);
    }
    return gitDir;
  }

  async function headSha(gitDir: string): Promise<string | null> {
    try {
      return (await runGitText(gitDir, ['rev-parse', '--verify', '-q', BRANCH])).trim() || null;
    } catch {
      return null;
    }
  }

  async function readTree(gitDir: string, head: string | null): Promise<Map<string, TreeEntry>> {
    const map = new Map<string, TreeEntry>();
    if (!head) return map;
    const out = await runGitText(gitDir, ['ls-tree', '-r', '-z', head]);
    for (const rec of out.split('\0')) {
      const m = /^(\d+) blob ([0-9a-f]+)\t(.*)$/s.exec(rec);
      if (m) map.set(m[3]!, { mode: m[1]!, sha: m[2]! });
    }
    return map;
  }

  async function writeTree(gitDir: string, files: Map<string, TreeEntry>): Promise<string> {
    const build = async (prefix: string): Promise<string> => {
      const lines: string[] = [];
      const subdirs = new Set<string>();
      for (const [path, e] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) lines.push(`${e.mode} blob ${e.sha}\t${rest}`);
        else subdirs.add(rest.slice(0, slash));
      }
      for (const d of subdirs) lines.push(`040000 tree ${await build(`${prefix}${d}/`)}\t${d}`);
      return (await runGitText(gitDir, ['mktree'], { input: lines.length ? `${lines.join('\n')}\n` : '' })).trim();
    };
    return build('');
  }

  async function readSnapshot(sourcePath: string): Promise<{ bytes: Buffer } | { skip: string }> {
    const res = await snapshotBytes({ path: sourcePath, maxBytes, mediaType: 'text/plain' });
    // The reason text names the absolute source path; the code is what we record.
    return res.ok ? { bytes: res.bytes } : { skip: res.code };
  }

  async function commit(input: RevisionInput): Promise<string | null> {
    const { ticketId } = input;
    const treePath = `${input.repo}/${input.relPath}`;
    if (!isSafeTreePath(treePath) || !isSafeTreePath(input.repo)) {
      await recordSkip(ticketId, treePath, 'unsafe-path');
      return null;
    }
    if (isSecretPath(input.relPath)) {
      await recordSkip(ticketId, treePath, 'secret-pattern');
      return null;
    }
    let bytes: Buffer | null = null;
    if (!input.deleted) {
      const snap = await readSnapshot(input.sourcePath);
      if ('skip' in snap) {
        await recordSkip(ticketId, treePath, snap.skip);
        return null;
      }
      bytes = snap.bytes;
    }
    const gitDir = await ensureRepo(ticketId);
    const head = await headSha(gitDir);
    const files = await readTree(gitDir, head);
    const current = files.get(treePath);
    if (bytes === null) {
      if (!current) return null;
      files.delete(treePath);
    } else {
      const blob = (await runGitText(gitDir, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes })).trim();
      if (current?.sha === blob) return null;
      if (treePathConflicts(files, treePath)) {
        await recordSkip(ticketId, treePath, 'path-conflict');
        return null;
      }
      files.set(treePath, { mode: '100644', sha: blob });
    }
    const tree = await writeTree(gitDir, files);
    const t = input.trailers ?? {};
    const trailerLines = Object.entries(t)
      .filter(([, v]) => typeof v === 'string' && v !== '')
      .map(([k, v]) => `Karst-${k[0]!.toUpperCase()}${k.slice(1)}: ${clean(v as string)}`);
    const subject = `${bytes === null ? 'delete' : 'update'} ${treePath}`;
    const message = `${subject}\n\n${trailerLines.join('\n')}\n`;
    const when = now().toISOString();
    const args = ['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'];
    const sha = (await runGitText(gitDir, args, {
      input: message,
      env: { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    })).trim();
    await runGit(gitDir, ['update-ref', BRANCH, sha, head ?? '0000000000000000000000000000000000000000']);
    return sha;
  }

  async function readableRepo(ticketId: number): Promise<string | null> {
    const gitDir = gitDirOf(ticketId);
    return (await exists(join(gitDir, 'HEAD'))) ? gitDir : null;
  }

  return {
    commitRevision: (input) => queue.run(String(input.ticketId), () => commit(input)),

    async listArtifacts(ticketId) {
      const gitDir = await readableRepo(ticketId);
      if (!gitDir) return [];
      const head = await headSha(gitDir);
      const files = await readTree(gitDir, head);
      const out: ArtifactSummary[] = [];
      for (const path of [...files.keys()].sort()) {
        const count = await runGitText(gitDir, ['rev-list', '--count', BRANCH, '--', path]);
        const latest = (await runGitText(gitDir, ['rev-list', '-1', BRANCH, '--', path])).trim();
        out.push({ path, revisions: Number(count.trim()), latestSha: latest });
      }
      return out;
    },

    async history(ticketId, path) {
      const gitDir = await readableRepo(ticketId);
      if (!gitDir || !(await headSha(gitDir))) return [];
      const raw = await runGitText(gitDir, ['log', '--format=%H%x1f%aI%x1f%B%x1e', BRANCH, '--', path]);
      return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((rec) => {
        const [sha = '', at = '', body = ''] = rec.split('\x1f');
        const trailers: Record<string, string> = {};
        for (const line of body.split('\n')) {
          const m = /^Karst-(\w+): (.*)$/.exec(line);
          if (m) trailers[m[1]!.toLowerCase()] = m[2]!;
        }
        return { sha, at, trailers };
      });
    },

    async show(ticketId, sha, path) {
      const gitDir = await readableRepo(ticketId);
      if (!gitDir || !SHA.test(sha)) throw new Error('unknown artifact revision');
      return runGit(gitDir, ['cat-file', 'blob', `${sha}:${path}`]);
    },

    async diff(ticketId, a, b, path) {
      const gitDir = await readableRepo(ticketId);
      if (!gitDir || !SHA.test(a) || !SHA.test(b)) throw new Error('unknown artifact revision');
      return runGitText(gitDir, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', a, b, '--', path]);
    },

    async listSkips(ticketId) {
      try {
        return (await readFile(skipsFile(ticketId), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as SkipRecord);
      } catch {
        return [];
      }
    },

    purgeArtifacts: (ticketId) =>
      queue.run(String(ticketId), async () => {
        await rm(dirOf(ticketId), { recursive: true, force: true });
      }),

    async purgeStale(maxAgeDays) {
      const cutoff = now().getTime() - maxAgeDays * 86_400_000;
      const purged: number[] = [];
      let names: string[] = [];
      try {
        names = await readdir(join(opts.artifactsRoot, `p${opts.projectId}`));
      } catch {
        return purged;
      }
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const ticketId = Number(name);
        const stale = await queue.run(name, async () => {
          const gitDir = await readableRepo(ticketId);
          if (!gitDir || !(await headSha(gitDir))) return false;
          const secs = Number((await runGitText(gitDir, ['log', '-1', '--format=%ct', BRANCH])).trim());
          if (!Number.isFinite(secs) || secs * 1000 >= cutoff) return false;
          await rm(dirOf(ticketId), { recursive: true, force: true });
          return true;
        });
        if (stale) purged.push(ticketId);
      }
      return purged;
    },
  };
}
