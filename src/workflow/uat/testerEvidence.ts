/**
 * The deterministic "did the Tester use the probe" check (arch:UAT-OBS-RUNS).
 * It reads two facts only: the ticket diff and the evidence files in the
 * worktree. It never reads the agent's answer, a transcript or a core name,
 * so it holds for every agent core.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';
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
  /** The id the host gave this Tester run; a direct-run summary counts only when it carries it. */
  runId?: string;
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
export async function changedPaths(
  input: Pick<EvidenceCheckInput, 'baseRef' | 'branch' | 'worktreePath' | 'git'>,
): Promise<string[] | null> {
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

/** The first changed non-test path that one of the globs matches. */
export function firstTriggerPath(changed: readonly string[], globs: readonly string[]): string | undefined {
  const triggers = globs.map(globToRegExp);
  return changed.find((p) => !TEST_FILE.test(p) && triggers.some((re) => re.test(p)));
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
  const trigger = firstTriggerPath(changed, rule.whenChanged);
  if (trigger === undefined) return { kind: 'not-required' };
  const fs = input.fs ?? defaultEvidenceFs;
  const pattern = globToRegExp(rule.file);
  const files = await fs.list(input.worktreePath, globStaticDir(rule.file), (rel) => pattern.test(rel));
  const isFresh = (f: EvidenceFile): boolean => f.mtimeMs >= input.startedAtMs;
  const probes = files.filter((f) => pattern.test(f.rel) && !isDirectPath(f.rel) && isFresh(f));
  if (probes.length > 0) return probeVerdict(input, fs, probes);
  const direct = await findDirectRun(input, fs);
  if (direct !== undefined) {
    return { kind: 'present', detail: `recorded direct run found (${direct}); it counts as evidence` };
  }
  return {
    kind: 'missing',
    detail: `no probe evidence: no probe summary matching ${rule.file} and no recorded direct run of this run is newer than the run start, and the diff touches ${trigger}`,
  };
}

async function probeVerdict(input: EvidenceCheckInput, fs: EvidenceFs, fresh: EvidenceFile[]): Promise<EvidenceCheck> {
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

/** Where the direct-run recorder writes (`directRunRecorder.mjs`); always below the scratch out dir. */
export const DIRECT_RUN_DIR = '.karst/uat-scratch/out/direct';
const DIRECT_SUMMARY = /^\.karst\/uat-scratch\/out\/direct\/[^/]+\/summary\.json$/;
const isDirectPath = (rel: string): boolean => rel.startsWith(`${DIRECT_RUN_DIR}/`);

/** The recorder's shape: a summary of any other shape is not evidence. */
function isDirectRunSummary(value: unknown, runId: string | undefined): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const shaped =
    v.kind === 'direct-run' &&
    Array.isArray(v.command) &&
    v.command.length > 0 &&
    typeof v.exitCode === 'number' &&
    typeof v.startedAt === 'string' &&
    typeof v.finishedAt === 'string';
  return shaped && (runId === undefined || v.runId === runId);
}

/** The first fresh, readable direct-run summary that this run wrote, or undefined. */
async function findDirectRun(input: EvidenceCheckInput, fs: EvidenceFs): Promise<string | undefined> {
  const listed = await fs.list(input.worktreePath, DIRECT_RUN_DIR, (rel) => DIRECT_SUMMARY.test(rel));
  for (const file of listed) {
    if (!DIRECT_SUMMARY.test(file.rel) || file.mtimeMs < input.startedAtMs) continue;
    try {
      const parsed: unknown = JSON.parse(await fs.read(join(input.worktreePath, file.rel)));
      if (isDirectRunSummary(parsed, input.runId)) return file.rel;
    } catch {
      // An unreadable direct-run file is not evidence.
    }
  }
  return undefined;
}

/**
 * The direct-run recorder, as an absolute path inside karst's own install (see
 * `harnessRunnerPath`: never `import.meta.url`, which is `dist/extension.js` once bundled).
 */
export function directRunRecorderPath(): string {
  return join(RUNTIME_ASSETS_ROOT, 'workflow/uat/directRunRecorder.mjs');
}

/** The one paragraph that states the evidence rule; the first prompt and the re-ask share it. */
export function evidenceRuleParagraph(runId: string): string {
  const recorder = `node '${directRunRecorderPath().replace(/'/g, "'\\''")}' --name <name> --run ${runId} -- <command...>`;
  return (
    'This change touches code that needs evidence: show a probe run or a recorded direct run. ' +
    `Record a direct run (for example npx tsx) with: ${recorder} ` +
    'A direct run that the recorder did not write does not count. ' +
    'A SKIPPED coverage entry without either kind of evidence is not an accepted outcome.'
  );
}

/** The text prepended to the Tester prompt on the one re-ask after a missing-evidence skip. */
export function evidenceReaskPrefix(detail: string, runId: string): string {
  return (
    `Your previous UAT run on this ticket left no evidence (${detail}).\n` +
    evidenceRuleParagraph(runId)
  );
}
