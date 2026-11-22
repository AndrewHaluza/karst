/**
 * Pure, zero-I/O quality checks of a planning draft (`@arch:DRAFT-QUALITY`).
 * Every check is a WARNING, never a rejection (`@arch:DRAFT-CONSTRAINTS`), and
 * every warning is at most MAX_WARNING_CHARS long so the sidebar card stays on
 * one line. The checks cascade so that one draft does not stack callouts that
 * say the same thing.
 */

export const MAX_WARNING_CHARS = 60;
export const THIN_DESCRIPTION_CHARS = 120;
export const PLAN_ARTIFACT_SHORT_CHARS = 300;
export const PLAN_ARTIFACT_THIN_CHARS = 500;
export const INVERSION_RATIO = 1.5;
export const INVERSION_MAX_DESCRIPTION = 1000;
export const INVERSION_MIN_SUMMARY_PATHS = 2;
export const DUPLICATE_MIN_CHARS = 400;
export const DUPLICATE_SIMILARITY = 0.75;
export const THIN_SUMMARY_CHARS = 80;
export const OVERSIZED_DESCRIPTION_CHARS = 12_000;
const SHINGLE_WORDS = 4;
const MIN_NUMBERED_STEPS = 2;

export const LEAK_WARNING = 'draft references session/agent plan path (inline it)';
export const DROPPED_PLAN_WARNING = 'session has plan artifact but description is short';
export const INVERTED_WARNING = 'plan details in summary instead of description';
export const DUPLICATE_WARNING = 'description and summary duplicate each other';
export const NO_PATHS_WARNING = 'no repo file paths named in description';
export const NO_VERIFICATION_WARNING = 'no test or verification plan in description';

export interface DraftText {
  description: string;
  summary: string;
  repos: readonly string[];
}

export interface ReferencedPaths {
  /** Paths the draft edits: they must exist at the planned base. */
  existing: string[];
  /** Paths the draft creates (`[NEW]`, `add `, a "New files" heading): never checked. */
  created: string[];
  /** Distinct repo paths plus root config/build files: "does the draft name a file at all". */
  anyPathCount: number;
}

/** `token` cut to `max` chars; a long one keeps its tail (the file name) behind `…`. */
export function clipToken(token: string, max: number): string {
  return token.length <= max ? token : `…${token.slice(token.length - (max - 1))}`;
}

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

const URI = /\b(?:https?|file):\/\/\S+/g;
const PATH_ROOTS = '(?:\\.github|src|tests|scripts|docs|packages|lib|app|apps|cmd|internal)';
/** A root at a token start (not inside `foo/src/…`), then everything up to a delimiter. */
const RAW_PATH = new RegExp(`(?<![\\w./-])${PATH_ROOTS}\\/[^\\s\`'"()\\[\\],;|]*`, 'g');
const ROOT_FILE = /(?<![\w./-])(?:package\.json|tsconfig[\w.-]*\.json|Dockerfile|Makefile|[\w.-]+\.ya?ml)(?![\w/-]|\.\w)/g;
const GLOB = /[*?<>{}]|\.\.\./;
const TRAILING = /[.,:;!?*/]+$/;
const LINE_SUFFIX = /:\d+(?:[-:]\d+)*$/;
const CREATED_MARKER = /\[NEW\]|\(new\)|\bnew file\b|\bcreate |\bcreating |\badd /i;
const HEADING = /^\s{0,3}#{1,6}\s/;
const NEW_FILES_HEADING = /\bnew files?\b/i;

/** The cleaned path of one raw match, or undefined for a glob, a placeholder or a bare root. */
function cleanPath(raw: string): string | undefined {
  const noAnchor = raw.split('#')[0]!;
  const path = noAnchor.replace(TRAILING, '').replace(LINE_SUFFIX, '').replace(TRAILING, '');
  if (GLOB.test(path)) return undefined;
  const slash = path.indexOf('/');
  return slash > 0 && slash < path.length - 1 ? path : undefined;
}

export function extractReferencedPaths(text: string): ReferencedPaths {
  const created = new Set<string>();
  const seen = new Set<string>();
  let rootFiles = 0;
  let inNewSection = false;
  for (const line of text.replace(URI, ' ').split('\n')) {
    if (HEADING.test(line)) inNewSection = NEW_FILES_HEADING.test(line);
    const isCreated = inNewSection || CREATED_MARKER.test(line);
    for (const m of line.matchAll(RAW_PATH)) {
      const path = cleanPath(m[0]);
      if (!path) continue;
      seen.add(path);
      if (isCreated) created.add(path);
    }
    rootFiles += [...line.matchAll(ROOT_FILE)].length;
  }
  const all = [...seen];
  return {
    existing: all.filter((p) => !created.has(p)),
    created: all.filter((p) => created.has(p)),
    anyPathCount: all.length + rootFiles,
  };
}

const LEAK_PATTERNS: readonly RegExp[] = [
  /\$\{?KARST_ARTIFACTS\b/,
  /planning-scratch\/[^/\s]+\/artifacts\b/,
  /globalStorage\/\S*?\/artifacts\b/,
  /(?:^|[\s'"`(=])\/(?:private\/)?tmp\/\S*?\/artifacts\b/m,
  /\.gemini\/\S*?\/brain\//,
  /(?<![\w.-])\.claude\/plans\//,
  /\.claude\/projects\/\S*?\/memory\//,
  /(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.codex\//,
  /(?<![\w.-])\.opencode\/plans\//,
  /(?<![\w./-])docs\/superpowers\/plans\//,
];

const VERIFICATION =
  /\b(?:test|tests|vitest|jest|pytest|playwright|spec|verify|verification|assert|acceptance|done when|typecheck|gate|lint|build|compile|confirm|reproduce|smoke)\b/i;
const NUMBERED_STEP = /^\s*(?:\d+[.)]|step\s+\d+\b)/i;

function hasNumberedSteps(text: string): boolean {
  return text.split('\n').filter((l) => NUMBERED_STEP.test(l)).length >= MIN_NUMBERED_STEPS;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s/._-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function shingles(norm: string): Set<string> {
  const words = norm.split(' ').filter(Boolean);
  if (words.length < SHINGLE_WORDS) return new Set([words.join(' ')]);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) out.add(words.slice(i, i + SHINGLE_WORDS).join(' '));
  return out;
}

function lineSet(text: string): Set<string> {
  return new Set(text.split('\n').map(normalize).filter(Boolean));
}

function isDuplicate(desc: string, sum: string): boolean {
  const nd = normalize(desc);
  const ns = normalize(sum);
  if (nd.length > 0 && nd === ns) return true;
  if (desc.length < DUPLICATE_MIN_CHARS || sum.length < DUPLICATE_MIN_CHARS) return false;
  if (nd.includes(ns) || ns.includes(nd)) return true;
  return Math.max(jaccard(shingles(nd), shingles(ns)), jaccard(lineSet(desc), lineSet(sum))) >= DUPLICATE_SIMILARITY;
}

function isInverted(desc: string, sum: string, descPaths: ReferencedPaths, sumPaths: ReferencedPaths): boolean {
  if (desc.length >= INVERSION_MAX_DESCRIPTION) return false;
  const longerSummary =
    sum.length > desc.length * INVERSION_RATIO &&
    (descPaths.anyPathCount === 0 || (hasNumberedSteps(sum) && !hasNumberedSteps(desc)));
  const pathsInSummary = sumPaths.anyPathCount >= INVERSION_MIN_SUMMARY_PATHS && descPaths.anyPathCount === 0;
  return longerSummary || pathsInSummary;
}

export function draftQualityWarnings(p: DraftText, opts: { hasPlanArtifact?: boolean } = {}): string[] {
  const desc = p.description;
  const sum = p.summary;
  const descPaths = extractReferencedPaths(desc);
  const sumPaths = extractReferencedPaths(sum);
  const verified = VERIFICATION.test(desc);
  const out: string[] = [];
  if (LEAK_PATTERNS.some((re) => re.test(`${desc}\n${sum}`))) out.push(LEAK_WARNING);
  const thin = desc.length < THIN_DESCRIPTION_CHARS;
  if (thin) out.push(`description is short (${desc.length} chars)`);
  const dropped =
    !thin &&
    opts.hasPlanArtifact === true &&
    (desc.length < PLAN_ARTIFACT_SHORT_CHARS ||
      (desc.length < PLAN_ARTIFACT_THIN_CHARS && (descPaths.anyPathCount === 0 || !verified)));
  if (dropped) out.push(DROPPED_PLAN_WARNING);
  const inverted = isInverted(desc, sum, descPaths, sumPaths);
  if (inverted) out.push(INVERTED_WARNING);
  else if (isDuplicate(desc, sum)) out.push(DUPLICATE_WARNING);
  if (sum.length < THIN_SUMMARY_CHARS) out.push(`summary is short (${sum.length} chars)`);
  const coded = p.repos.length > 0;
  if (coded && !thin && !dropped && !inverted && descPaths.anyPathCount === 0) out.push(NO_PATHS_WARNING);
  if (coded && !thin && !inverted && !verified) out.push(NO_VERIFICATION_WARNING);
  if (desc.length > OVERSIZED_DESCRIPTION_CHARS) out.push(`description is very large (${desc.length} chars; split draft)`);
  return out;
}
