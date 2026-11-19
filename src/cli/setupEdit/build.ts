/**
 * The host build of a typed edit list (@arch:CLI-21): replay the ops, in order,
 * on the raw tree of the latest karst.yml, then render through the write path.
 * Pure over the injected `loadText`, so the CLI (at tool-call time) and the host
 * (at popup time) run the same code.
 *
 * Order matters (@arch:FIELDCHK): patch raw -> dump -> load -> `renderManifestText`
 * over the BASE text -> load again. The rendered text only holds what the write
 * overlay models, so a field the validator knows but the overlay drops shows as
 * a missing value, never as a pass.
 */

import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { foldProcessRows } from '../../manifest/foldProcessRows.js';
import { migrateLegacyManifest } from '../../manifest/migrate.js';
import { SECTION_OF } from '../../manifest/sectionTable.js';
import type { Manifest } from '../../manifest/types.js';
import type { CodedWarning } from '../../manifest/warningCode.js';
import { renderManifestText } from '../../manifest/write.js';
import { validateJson } from '../jsonSchema.js';
import { MANIFEST_SECTION_SCHEMAS } from '../manifestSchemas/index.js';
import type { ManifestSection } from '../manifestSchemas/index.js';
import { diffPaths } from '../../setup/pathDiff.js';
import type { PathChange } from '../../setup/pathDiff.js';
import { findEditTool } from './tools.js';
import type { EditOp } from './tools.js';

type Tree = Record<string, unknown>;

const isTree = (v: unknown): v is Tree => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Loads karst.yml text; the verify deps' `loadText` fits. */
export type LoadText = (text: string) => { ok: true; manifest: Manifest; codedWarnings: readonly CodedWarning[] } | { ok: false; error: string };

export interface BuildContext {
  /** True on the first setup: `id` is then settable. */
  firstSetup: boolean;
  /** The karst.yml the host writes when the file does not exist (the stamped scaffold). */
  scaffoldText?: string;
}

export type BuildFailure = { ok: false; opId?: string; field?: string; reason: string };

export interface BuildSuccess {
  ok: true;
  /** The karst.yml text the host writes. */
  text: string;
  manifest: Manifest;
  /** The loaded base (the scaffold when the file does not exist); `undefined` when the base does not load. */
  before: Manifest | undefined;
  changes: readonly PathChange[];
  /** True when the host writes the scaffold first (the file does not exist). */
  scaffolded: boolean;
  warnings: readonly CodedWarning[];
  /** The fix codes the ops named. */
  fixes: readonly string[];
}

export type BuildOutcome = BuildSuccess | BuildFailure;

interface Step {
  /** The patch to merge; `null` for a rewrite-only step (`fix`). */
  patch: Tree | null;
  fix?: string;
}

const isFailure = (v: unknown): v is BuildFailure => isTree(v) && v.ok === false && typeof v.reason === 'string';

const fail = (reason: string, extra: { opId?: string; field?: string } = {}): BuildFailure => ({ ok: false, reason, ...extra });

/** `base` with `patch` merged in: a mapping merges, anything else replaces, `null` removes the key. */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isTree(patch)) return patch;
  const out: Tree = isTree(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/** Fixes the host can build: the readiness item code -> what the rewrite clears. */
export const KNOWN_FIXES: ReadonlyMap<string, string> = new Map([
  ['manifest.legacy-services', 'Rewrite karst.yml in the current format: the retired `services` map becomes `repositories`.'],
]);

function field(tree: unknown, key: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = isTree(tree) ? tree[key] : undefined;
  return typeof value === 'string' && value !== ''
    ? { ok: true, value }
    : { ok: false, reason: `${key} must be a non-empty string` };
}

function toStep(op: EditOp, raw: Tree): Step | BuildFailure {
  const tool = findEditTool(op.tool);
  if (tool === undefined) return fail(`unknown setup tool "${op.tool}"`, { opId: op.id });
  if (tool.proposal !== undefined) return fail(`"${op.tool}" is a host proposal, not an edit`, { opId: op.id });
  const input = op.input;
  if (tool.section !== undefined) {
    if (!isTree(input)) return fail('the input must be an object', { opId: op.id, field: '$' });
    const outside = Object.keys(input).find((k) => (SECTION_OF as Record<string, ManifestSection | undefined>)[k] !== tool.section);
    if (outside !== undefined) return fail(`"${outside}" is not a field of the ${tool.section} section`, { opId: op.id, field: outside });
    return { patch: input };
  }
  return repoStep(op, tool.name, input, raw);
}

function repoStep(op: EditOp, name: string, input: unknown, raw: Tree): Step | BuildFailure {
  const bad = (reason: string, f?: string): BuildFailure => fail(reason, { opId: op.id, ...(f !== undefined ? { field: f } : {}) });
  if (!isTree(input)) return bad('the input must be an object', '$');
  if (name === 'fix') {
    const code = field(input, 'code');
    if (!code.ok) return bad(code.reason, 'code');
    if (!KNOWN_FIXES.has(code.value)) {
      return bad(`no host-built fix for "${code.value}"; known: ${[...KNOWN_FIXES.keys()].join(', ')}`, 'code');
    }
    return { patch: null, fix: code.value };
  }
  const repoKey = name.endsWith('service') ? 'repo' : 'name';
  const repo = field(input, repoKey);
  if (!repo.ok) return bad(repo.reason, repoKey);
  const repos = isTree(raw.repositories) ? raw.repositories : {};
  const exists = isTree(repos[repo.value]);
  if (name === 'add-repo') {
    if (exists) return bad(`repository "${repo.value}" already exists; use set-repo`, 'name');
    if (!isTree(input.repo)) return bad('repo must be an object', 'repo');
    return { patch: { repositories: { [repo.value]: input.repo } } };
  }
  if (!exists) return bad(`repository "${repo.value}" does not exist`, repoKey);
  if (name === 'remove-repo') return { patch: { repositories: { [repo.value]: null } } };
  const entry = serviceEntry(input);
  if (!entry.ok) return bad(entry.reason, 'name');
  const wrap = (value: unknown): Tree => ({ repositories: { [repo.value]: entry.wrap(value) } });
  if (name === 'remove-service') return { patch: wrap(null) };
  if (!isTree(input.patch)) return bad('patch must be an object', 'patch');
  return name === 'set-repo' ? { patch: { repositories: { [repo.value]: input.patch } } } : { patch: wrap(input.patch) };
}

function serviceEntry(input: Tree): { ok: true; wrap: (value: unknown) => Tree } | { ok: false; reason: string } {
  if (input.name === undefined) return { ok: true, wrap: (value) => ({ service: value }) };
  const name = field(input, 'name');
  if (!name.ok) return name;
  return { ok: true, wrap: (value) => ({ services: { [name.value]: value } }) };
}

const NONE_OF = /^\$[^:]*: matches none of the alternatives \((.*)\)$/s;
const pathOf = (e: string): string => /^\$([^:]*):/.exec(e)?.[1] ?? '';

/** The most specific alternative error (the deepest path) of a oneOf or anyOf failure: it names the field, not the tree. */
function deepestAlternative(error: string): string {
  const inner = NONE_OF.exec(error)?.[1];
  if (inner === undefined) return error;
  const alternatives = inner.split('; $').map((e, i) => (i === 0 ? e : `$${e}`));
  const best = alternatives.reduce((a, b) => (pathOf(b).length > pathOf(a).length ? b : a));
  return deepestAlternative(trimClosers(best));
}

/** Drop the closing parentheses of enclosing alternative lists that the split left on a segment. */
function trimClosers(segment: string): string {
  let out = segment;
  while (out.endsWith(')') && out.split(')').length > out.split('(').length) out = out.slice(0, -1);
  return out;
}

/** `$.a.b: message` -> the field `a.b` and the reason. */
export function splitSchemaError(raw: string): { field: string; reason: string } {
  const error = deepestAlternative(raw);
  const at =/^\$([^:]*): (.*)$/s.exec(error);
  if (at === null) return { field: '$', reason: error };
  const path = at[1]!.replace(/^\./, '');
  return { field: path === '' ? '$' : path, reason: at[2]! };
}

function touchedSections(patch: Tree): ManifestSection[] | BuildFailure {
  const sections = new Set<ManifestSection>();
  for (const key of Object.keys(patch)) {
    const section = (SECTION_OF as Record<string, ManifestSection | undefined>)[key];
    if (section === undefined) return fail(`"${key}" is not a manifest field`, { field: key });
    sections.add(section);
  }
  return [...sections];
}

function parseBase(text: string): Tree | BuildFailure {
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (e) {
    return fail(`YAML parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const migrated = migrateLegacyManifest(isTree(parsed) ? parsed : {}).raw;
  return isTree(migrated) ? migrated : {};
}

/** Replays the ops on `raw`; the first failure names its op. */
function replay(raw: Tree, ops: readonly EditOp[]): { raw: Tree; fixes: string[] } | BuildFailure {
  let tree = raw;
  const fixes: string[] = [];
  for (const op of ops) {
    const step = toStep(op, tree);
    if (isFailure(step)) return step;
    if (step.fix !== undefined) fixes.push(step.fix);
    if (step.patch === null) continue;
    const sections = touchedSections(step.patch);
    if (!Array.isArray(sections)) return { ...sections, opId: op.id };
    tree = mergePatch(tree, step.patch) as Tree;
    for (const section of sections) {
      // The loader folds unpinned process rows before it validates; the schemas see the same tree.
      const error = validateJson(MANIFEST_SECTION_SCHEMAS[section], foldProcessRows(tree).raw);
      if (error !== null) return { ...fail('', { opId: op.id }), ...splitSchemaError(error) };
    }
  }
  return { raw: tree, fixes };
}

function idViolation(ops: readonly EditOp[], before: Manifest | undefined, after: Manifest): BuildFailure | undefined {
  if (before?.id === after.id) return undefined;
  const op = ops.find((o) => isTree(o.input) && 'id' in o.input);
  return fail('id is settable only on the first setup', { field: 'id', ...(op !== undefined ? { opId: op.id } : {}) });
}

export function buildEdits(baseText: string | undefined, ops: readonly EditOp[], ctx: BuildContext, loadText: LoadText): BuildOutcome {
  const scaffolded = baseText === undefined;
  const base = baseText ?? ctx.scaffoldText ?? '{}\n';
  const raw = parseBase(base);
  if (isFailure(raw)) return raw;
  const replayed = replay(raw, ops);
  if (isFailure(replayed)) return replayed;
  const loaded = loadText(yamlDump(replayed.raw, { lineWidth: -1, noRefs: true }));
  if (!loaded.ok) return fail(loaded.error);
  let text: string;
  try {
    text = renderManifestText(base, loaded.manifest);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const final = loadText(text);
  if (!final.ok) return fail(final.error);
  const baseLoaded = loadText(base);
  const before = baseLoaded.ok ? baseLoaded.manifest : undefined;
  if (!ctx.firstSetup) {
    const violation = idViolation(ops, before, final.manifest);
    if (violation !== undefined) return violation;
  }
  return {
    ok: true,
    text,
    manifest: final.manifest,
    before,
    changes: diffPaths(before, final.manifest),
    scaffolded,
    warnings: final.codedWarnings,
    fixes: replayed.fixes,
  };
}
