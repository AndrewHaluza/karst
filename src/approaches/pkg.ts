import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { ManifestError } from '../manifest/schema.js';
import type { WorkflowPhase } from '../manifest/types.js';
import { isSafePhaseName, phaseNameFault } from './phaseName.js';

/**
 * Neutral, agent-agnostic on-disk approach package: metadata (approach.yml) +
 * raw instruction docs (prompts/*.md). No Claude-specific field names — later
 * tasks fetch upstream content into this format and read it back.
 */
/**
 * A structure-preserving, agent-agnostic component of an approach. `kind`
 * classifies it neutrally (no "plugin" concept); `relPath` is the path under
 * the package dir, preserving the source's directory layout (a skill IS its
 * folder, e.g. skills/<name>/SKILL.md). The AgentAdapter translates these at
 * launch — nothing Claude-specific lives here.
 */
export interface ApproachArtifact {
  kind: 'agent' | 'skill' | 'command';
  relPath: string;
}

export interface ApproachPackage {
  id: string;
  label: string;
  description?: string;
  entrypoint?: string;
  /** Relative filenames under prompts/, e.g. "main.md". Legacy flat model. */
  prompts: string[];
  /**
   * Structure-preserving typed inventory (agents/skills/commands). Absent on
   * legacy flat packages. When present, `relPath`s are written verbatim under
   * the package dir. The adapter materializes these into an agent's format.
   */
  artifacts?: ApproachArtifact[];
  /** Ordered dev-workflow phases (§ onboarding), when the approach defines one. */
  workflow?: WorkflowPhase[];
}

/**
 * Reject any id/name that could escape the package directory: path
 * separators, `..` segments, or an absolute path. This is the
 * path-traversal guard shared by approachDir/read/write.
 */
function assertSafeId(id: string, where: string): void {
  if (id.length === 0) {
    throw new ManifestError(`${where} must be a non-empty string`);
  }
  if (id.includes('/') || id.includes('\\')) {
    throw new ManifestError(`${where} must not contain a path separator: "${id}"`);
  }
  if (id === '..' || id.split('/').includes('..')) {
    throw new ManifestError(`${where} must not contain "..": "${id}"`);
  }
  if (isAbsolute(id)) {
    throw new ManifestError(`${where} must not be an absolute path: "${id}"`);
  }
}

/**
 * Reject a multi-segment relative path that could escape the package dir.
 * Unlike `assertSafeId`, separators ARE allowed (structure is preserved), but
 * every segment is guarded: no absolute path, no `..`, no empty/`.` segment.
 */
function assertSafeRelPath(relPath: string, where: string): void {
  if (relPath.length === 0) {
    throw new ManifestError(`${where} must be a non-empty string`);
  }
  if (isAbsolute(relPath)) {
    throw new ManifestError(`${where} must not be an absolute path: "${relPath}"`);
  }
  const segments = relPath.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg === '') {
      throw new ManifestError(`${where} has an unsafe segment: "${relPath}"`);
    }
  }
}

/** Resolve the on-disk directory for an approach package, id sanitized. */
export function approachDir(baseDir: string, id: string): string {
  assertSafeId(id, 'approach id');
  return join(baseDir, id);
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ManifestError(`${where} must be a non-empty string`);
  }
  return v;
}

function requireStringArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) {
    throw new ManifestError(`${where} must be an array of strings`);
  }
  return v.map((s, i) => requireString(s, `${where}[${i}]`));
}

const ARTIFACT_KINDS = ['agent', 'skill', 'command'] as const;
type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

function isArtifactKind(v: unknown): v is ArtifactKind {
  return typeof v === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(v);
}

/** Validate the optional `artifacts` list; every relPath is traversal-guarded. */
function requireArtifacts(v: unknown): ApproachArtifact[] {
  if (!Array.isArray(v)) {
    throw new ManifestError('artifacts must be an array');
  }
  return v.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ManifestError(`artifacts[${i}] must be a mapping`);
    }
    const rec = entry as Record<string, unknown>;
    if (!isArtifactKind(rec.kind)) {
      throw new ManifestError(`artifacts[${i}].kind must be one of ${ARTIFACT_KINDS.join('|')}`);
    }
    const relPath = requireString(rec.relPath, `artifacts[${i}].relPath`);
    assertSafeRelPath(relPath, `artifacts[${i}].relPath`);
    return { kind: rec.kind, relPath };
  });
}

/**
 * Reject a phase name that could not be safely interpolated into a command
 * line. Fails loudly at install rather than materializing a weaponized command.
 *
 * The charset and the wording live in `phaseName.ts` because the marker CLI
 * re-validates on receipt — argv is never trusted just because install-time
 * validation ran — and two copies of that regex would drift silently.
 */
function assertSafePhaseName(name: string, where: string): void {
  if (!isSafePhaseName(name)) {
    throw new ManifestError(phaseNameFault(where, name));
  }
}

/** Validate the optional `workflow` list; each phase requires a safe `name`. */
function requireWorkflow(v: unknown): WorkflowPhase[] {
  if (!Array.isArray(v)) {
    throw new ManifestError('workflow must be an array');
  }
  return v.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ManifestError(`workflow[${i}] must be a mapping`);
    }
    const rec = entry as Record<string, unknown>;
    const name = requireString(rec.name, `workflow[${i}].name`);
    assertSafePhaseName(name, `workflow[${i}].name`);
    return {
      name,
      ...(rec.command !== undefined
        ? { command: requireString(rec.command, `workflow[${i}].command`) }
        : {}),
      ...(rec.description !== undefined
        ? { description: requireString(rec.description, `workflow[${i}].description`) }
        : {}),
    };
  });
}

/** Parse a loaded YAML value into a minimally-validated ApproachPackage. */
function validateApproachPackage(raw: unknown): ApproachPackage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ManifestError('approach.yml top level must be a mapping');
  }
  const rec = raw as Record<string, unknown>;
  const id = requireString(rec.id, 'id');
  const label = requireString(rec.label, 'label');
  const prompts = requireStringArray(rec.prompts, 'prompts');

  return {
    id,
    label,
    prompts,
    ...(rec.description !== undefined
      ? { description: requireString(rec.description, 'description') }
      : {}),
    ...(rec.entrypoint !== undefined
      ? { entrypoint: requireString(rec.entrypoint, 'entrypoint') }
      : {}),
    ...(rec.artifacts !== undefined ? { artifacts: requireArtifacts(rec.artifacts) } : {}),
    ...(rec.workflow !== undefined ? { workflow: requireWorkflow(rec.workflow) } : {}),
  };
}

/**
 * Read an approach package's metadata from `<baseDir>/<id>/approach.yml`.
 * Returns null if the file is absent (package not installed). Throws
 * ManifestError on malformed YAML or a shape that fails minimal validation.
 */
export function readApproachPackage(baseDir: string, id: string): ApproachPackage | null {
  const dir = approachDir(baseDir, id);
  const metaPath = join(dir, 'approach.yml');
  if (!existsSync(metaPath)) {
    return null;
  }

  const text = readFileSync(metaPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (e) {
    throw new ManifestError(`approach.yml parse failed: ${(e as Error).message}`);
  }
  return validateApproachPackage(parsed);
}

/**
 * Write an approach package: prompt files under `<dir>/prompts/`, plus
 * `<dir>/approach.yml` holding the metadata. Both `pkg.id` and every prompt
 * `name` are sanitized against path traversal. Does not mutate `pkg` or
 * `prompts`.
 */
export function writeApproachPackage(
  baseDir: string,
  pkg: ApproachPackage,
  prompts: { name: string; body: string }[],
): void {
  const dir = approachDir(baseDir, pkg.id);
  const promptsDir = join(dir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  for (const prompt of prompts) {
    assertSafeId(prompt.name, 'prompt name');
    writeFileSync(join(promptsDir, prompt.name), prompt.body);
  }

  const meta: ApproachPackage = {
    id: pkg.id,
    label: pkg.label,
    ...(pkg.description !== undefined ? { description: pkg.description } : {}),
    ...(pkg.entrypoint !== undefined ? { entrypoint: pkg.entrypoint } : {}),
    prompts: [...pkg.prompts],
    ...(pkg.artifacts !== undefined ? { artifacts: pkg.artifacts.map((a) => ({ ...a })) } : {}),
    ...(pkg.workflow !== undefined ? { workflow: pkg.workflow.map((p) => ({ ...p })) } : {}),
  };
  writeFileSync(join(dir, 'approach.yml'), yamlDump(meta));
}

/**
 * Write a structure-preserving package: each file at its `relPath` under
 * `<baseDir>/<id>/` (mkdir -p per file), plus `approach.yml` carrying the typed
 * `artifacts` inventory. Every relPath is traversal-guarded per segment. Does
 * not mutate inputs. This is the neutral writer for the structured-fetch path;
 * `writeApproachPackage` remains for the legacy flat prompts model.
 */
export function writeApproachArtifacts(
  baseDir: string,
  pkg: ApproachPackage,
  files: { relPath: string; body: string }[],
): void {
  const dir = approachDir(baseDir, pkg.id);
  mkdirSync(dir, { recursive: true });

  for (const file of files) {
    assertSafeRelPath(file.relPath, 'artifact relPath');
    const dest = join(dir, file.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.body);
  }

  const meta: ApproachPackage = {
    id: pkg.id,
    label: pkg.label,
    ...(pkg.description !== undefined ? { description: pkg.description } : {}),
    ...(pkg.entrypoint !== undefined ? { entrypoint: pkg.entrypoint } : {}),
    prompts: [...pkg.prompts],
    artifacts: (pkg.artifacts ?? []).map((a) => ({ ...a })),
    ...(pkg.workflow !== undefined ? { workflow: pkg.workflow.map((p) => ({ ...p })) } : {}),
  };
  writeFileSync(join(dir, 'approach.yml'), yamlDump(meta));
}

/**
 * Read a structure-preserving artifact's body by its `relPath`. Both `id` and
 * `relPath` are traversal-guarded. Returns null when the file is absent.
 */
export function readArtifactBody(
  baseDir: string,
  id: string,
  relPath: string,
): string | null {
  assertSafeRelPath(relPath, 'artifact relPath');
  const path = join(approachDir(baseDir, id), relPath);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf8');
}

/** Filter a package's structured artifacts by kind (empty if none). */
export function listArtifacts(
  pkg: ApproachPackage,
  kind: ApproachArtifact['kind'],
): ApproachArtifact[] {
  return (pkg.artifacts ?? []).filter((a) => a.kind === kind);
}

/**
 * List all installed approach packages in `baseDir`. Reads each subdirectory
 * and collects the ones that contain a valid approach.yml. Silently skips
 * malformed or missing packages (those where readApproachPackage throws or
 * returns null). If `baseDir` does not exist, returns an empty array.
 * Order matches readdirSync (directory listing order).
 */
export function listInstalled(baseDir: string): ApproachPackage[] {
  if (!existsSync(baseDir)) {
    return [];
  }

  const result: ApproachPackage[] = [];
  const entries = readdirSync(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const pkg = readApproachPackage(baseDir, entry.name);
      if (pkg !== null) {
        result.push(pkg);
      }
    } catch {
      // Silently skip malformed packages (invalid yaml, missing fields, etc.)
      continue;
    }
  }

  return result;
}

/**
 * Remove an installed approach package directory (`<baseDir>/<id>/`). Id is
 * traversal-guarded via `approachDir`. Idempotent: absent dir → no-op.
 * Returns true if a package directory was removed, false if nothing was there.
 */
export function uninstallApproach(baseDir: string, id: string): boolean {
  const dir = approachDir(baseDir, id); // asserts safe id
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Read a single prompt file's body from an installed package's `prompts/`
 * directory. Both `id` and `promptName` are traversal-guarded. Returns null
 * when the file is absent (or the package/dir does not exist) — callers treat
 * that as "nothing to inject" rather than an error.
 */
export function readPromptBody(
  baseDir: string,
  id: string,
  promptName: string,
): string | null {
  assertSafeId(promptName, 'prompt name');
  const path = join(approachDir(baseDir, id), 'prompts', promptName);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf8');
}
