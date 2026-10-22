import { createHash } from 'node:crypto';

/** An argv entry longer than this is stored as its length, hash and head, never whole (DBG-03). */
export const ARGV_INLINE_MAX = 512;
const HEAD_CHARS = 200;
const SPILL_POINTER = /Your full kickoff brief is in (.+?); read it completely/;
const WORKSPACE_HASH = /workspace-[0-9a-f]{8}/g;
/** Per-run scratch dir (`mkdtemp`) and the hook settings file's pid + hash suffix. */
const RUN_DIR = /karst-uat-host-[A-Za-z0-9]{6}/g;
const HOOKS_FILE = /karst-hooks\.\d+\.[0-9a-f]+/g;

export type ArgvEntry = string | { len: number; sha256: string; head: string };
export interface SpillEvidence { len: number; sha256: string }
export interface LaunchRecord {
  provider: string;
  argv: ArgvEntry[];
  envKeys: string[];
  cwd: string;
  spill?: SpillEvidence;
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function summarize(arg: string): ArgvEntry {
  if (arg.length <= ARGV_INLINE_MAX) return arg;
  return { len: arg.length, sha256: sha256(arg), head: arg.slice(0, HEAD_CHARS) };
}

export interface LaunchInput {
  provider: string;
  argv: string[];
  envKeys: string[];
  cwd: string;
  /** Returns the file's bytes, or undefined when it cannot be read. */
  readFile(path: string): Buffer | undefined;
}

/** What one launch looked like, without prompt bodies or env values. */
export function buildLaunchRecord(input: LaunchInput): LaunchRecord {
  const base = {
    provider: input.provider,
    argv: input.argv.map(summarize),
    envKeys: [...input.envKeys].sort(),
    cwd: input.cwd,
  };
  for (const arg of input.argv) {
    const path = SPILL_POINTER.exec(arg)?.[1];
    const bytes = path === undefined ? undefined : input.readFile(path);
    if (bytes) return { ...base, spill: { len: bytes.length, sha256: sha256(bytes) } };
  }
  return base;
}

/** Parses launches.ndjson; a torn or foreign line is skipped, not fatal. */
export function parseLaunches(text: string): LaunchRecord[] {
  const out: LaunchRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as LaunchRecord);
    } catch {
      // a partially written line: the next poll sees it whole
    }
  }
  return out;
}

/** The per-run workspace hash varies between runs; evidence must be stable. */
export function normalizeLaunch(rec: LaunchRecord): LaunchRecord {
  const clean = (s: string) => s.replace(WORKSPACE_HASH, 'workspace-<hash>').replace(RUN_DIR, 'karst-uat-host-<run>').replace(HOOKS_FILE, 'karst-hooks.<id>');
  return {
    ...rec,
    cwd: clean(rec.cwd),
    argv: rec.argv.map((a) => (typeof a === 'string' ? clean(a) : { ...a, head: clean(a.head) })),
  };
}
