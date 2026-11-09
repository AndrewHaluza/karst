/**
 * The deterministic "did the Tester use the probe" check (arch:UAT-OBS-RUNS).
 * It reads two facts only: the ticket diff and the evidence files in the
 * worktree. It never reads the agent's answer, a transcript or a core name,
 * so it holds for every agent core.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { globToRegExp } from '../../artifacts/globMatch.js';
import type { GitRunner } from '../../integrations/git.js';
import type { UatTesterRequireEvidence } from '../../manifest/types.js';

export interface EvidenceFile {
  /** Path relative to the worktree root, `/`-separated. */
  rel: string;
  mtimeMs: number;
}

/** The file system seam: tests inject a fake, the default reads the real worktree. */
export interface EvidenceFs {
  /**
   * Every file below `dir` (relative to `root`) that `match` accepts; an absent
   * directory is an empty list. Throws when the walk visits too many entries,
   * so a truncated list can never read as "no evidence".
   */
  list(root: string, dir: string, match: (rel: string) => boolean): Promise<EvidenceFile[]>;
  read(path: string): Promise<string>;
}

export type EvidenceCheck =
  | { kind: 'not-required' }
  | { kind: 'present'; detail?: string }
  | { kind: 'missing'; detail: string }
  /** The evidence could not be read; the run is never failed or skipped for that. */
  | { kind: 'unverifiable'; detail: string };

export interface EvidenceCheckInput {
  rule: UatTesterRequireEvidence | undefined;
  worktreePath: string;
  baseRef?: string | null;
  branch?: string | null;
  /** The Tester run's start, in epoch ms: evidence must be at or after it. */
  startedAtMs: number;
  git: GitRunner;
  fs?: EvidenceFs;
}

/** A test file (`x.test.ts`, `x.spec.tsx`): a probe run proves nothing about it, so it never triggers the rule. */
const TEST_FILE = /\.(test|spec)\.[^/]*$/;

const GLOB_CHARS = /[*?[{]/;
/** The walk fails past this many entries, so a huge scratch directory cannot stall the run. */
export const MAX_EVIDENCE_FILES = 5000;

interface WalkState {
  out: EvidenceFile[];
  visited: number;
  match: (rel: string) => boolean;
}

async function walk(root: string, dir: string, state: WalkState): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    state.visited += 1;
    if (state.visited > MAX_EVIDENCE_FILES) {
      throw new Error(`more than ${MAX_EVIDENCE_FILES} entries under ${dir || '.'}`);
    }
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(root, rel, state);
    else if (entry.isFile() && state.match(rel)) {
      state.out.push({ rel, mtimeMs: (await stat(join(root, rel))).mtimeMs });
    }
  }
}

export const defaultEvidenceFs: EvidenceFs = {
  async list(root, dir, match) {
    const state: WalkState = { out: [], visited: 0, match };
    await walk(root, dir, state);
    return state.out;
  },
  read: (path) => readFile(path, 'utf8'),
};

/** The directory part of a glob before its first wildcard: the only place a match can be. */
export function globStaticDir(glob: string): string {
  const cut = glob.search(GLOB_CHARS);
  const head = cut === -1 ? glob : glob.slice(0, cut);
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash);
}

/** The ticket's changed paths, or null when git cannot say (the check then stays silent). */
async function changedPaths(input: EvidenceCheckInput): Promise<string[] | null> {
  const head = input.branch ?? 'HEAD';
  const bases = input.baseRef ? [`origin/${input.baseRef}`, input.baseRef] : [];
  for (const base of bases) {
    const out = await input.git(['diff', '--name-only', `${base}...${head}`], input.worktreePath);
    if (out.exitCode === 0) {
      return out.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    }
  }
  return null;
}

type FirstStep = 'passed' | 'failed' | 'unreadable';

/** The state of a summary's FIRST step: a failed harness still produced evidence, an unreadable file is said so. */
function firstStepState(text: string): FirstStep {
  try {
    const parsed = JSON.parse(text) as { results?: Array<{ status?: unknown }> };
    const first = parsed.results?.[0]?.status;
    return first === 'fail' || first === 'timeout' ? 'failed' : 'passed';
  } catch {
    return 'unreadable';
  }
}

export async function checkProbeEvidence(input: EvidenceCheckInput): Promise<EvidenceCheck> {
  try {
    return await decide(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'unverifiable', detail: `probe evidence could not be checked: ${reason}` };
  }
}

async function decide(input: EvidenceCheckInput): Promise<EvidenceCheck> {
  const { rule } = input;
  if (rule === undefined) return { kind: 'not-required' };
  const changed = await changedPaths(input);
  if (changed === null) return { kind: 'not-required' };
  const triggers = rule.whenChanged.map(globToRegExp);
  const trigger = changed.find((p) => !TEST_FILE.test(p) && triggers.some((re) => re.test(p)));
  if (trigger === undefined) return { kind: 'not-required' };
  const fs = input.fs ?? defaultEvidenceFs;
  const pattern = globToRegExp(rule.file);
  const files = await fs.list(input.worktreePath, globStaticDir(rule.file), (rel) => pattern.test(rel));
  const fresh = files.filter((f) => pattern.test(f.rel) && f.mtimeMs >= input.startedAtMs);
  if (fresh.length === 0) {
    return {
      kind: 'missing',
      detail: `no probe evidence: no file matching ${rule.file} is newer than the run start, and the diff touches ${trigger}`,
    };
  }
  const newest = fresh.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  let state: FirstStep;
  try {
    state = firstStepState(await fs.read(join(input.worktreePath, newest.rel)));
  } catch {
    state = 'unreadable';
  }
  if (state === 'failed') {
    return { kind: 'present', detail: `probe evidence found (${newest.rel}); its first step reports a harness failure, so the run still counts as evidence` };
  }
  if (state === 'unreadable') {
    return { kind: 'present', detail: `probe evidence found (${newest.rel}); the summary could not be read, so its first step is unknown and the run still counts as evidence` };
  }
  return { kind: 'present' };
}

/** The text prepended to the Tester prompt on the one re-ask after a missing-evidence skip. */
export function evidenceReaskPrefix(detail: string): string {
  return (
    `Your previous UAT run on this ticket left no probe evidence (${detail}).\n` +
    'This run needs at least one probe run. Run the probe, then report what it showed.'
  );
}
