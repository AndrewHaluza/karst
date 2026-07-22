import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, basename, relative } from 'node:path';
import type { ApproachDef } from '../manifest/types.js';
import {
  writeApproachArtifacts,
  type ApproachArtifact,
  type ApproachPackage,
} from './pkg.js';
import { classifyPath } from './classify.js';
import { sanitizeFrontmatter } from './sanitize.js';

/**
 * Git-source install driver (§ approaches). Fetches the markdown docs an
 * `ApproachDef.source` (type 'git') points at from the GitHub contents API and
 * writes them into a neutral on-disk package via `writeApproachPackage`.
 * Agent-agnostic: only markdown is moved, nothing Claude-specific. The HTTP
 * client is INJECTED (mirrors `src/integrations/clickup.ts`) so the module
 * stays pure and unit-testable — never call global `fetch` here.
 */

/** Fetch signature — the global `fetch` type, injected for testability. */
export type FetchLike = typeof fetch;

/**
 * Injected shell-out for the npm-source driver: run `cmd` in `cwd` and report
 * its exit code + captured output. NEVER call a real spawn here — this file
 * stays pure so tests can fake it. The real spawnSync-backed runner is wired
 * by the caller (not this module — see `src/runtime/worktree.ts` for the
 * shape this mirrors).
 */
export type RunCommand = (cmd: string, cwd: string) => { code: number; out: string };

export interface InstallDeps {
  fetchFn: FetchLike;
  baseDir: string;
  runCommand: RunCommand;
}

/** A typed error so callers never see a raw network/parse/HTTP-status throw. */
export class ApproachInstallError extends Error {
  constructor(message: string) {
    super(`ApproachInstall: ${message}`);
    this.name = 'ApproachInstallError';
  }
}

/** A single markdown doc collected from the source, ready for the Phase-B writer. */
interface CollectedPrompt {
  name: string;
  body: string;
}

/**
 * A file collected from one classified include/collect path, with its
 * package-relative destination path preserved (structure-preserving fetch). For
 * a skill folder this carries the whole subtree; the `kind` tags the include's
 * classification so the artifact inventory can be built.
 */
interface CollectedFile {
  relPath: string; // package-relative, e.g. "skills/tdd/SKILL.md"
  body: string;
  kind: ApproachArtifact['kind'];
}

/** Result of collecting one include path: either structured or legacy-flat. */
interface CollectResult {
  files: CollectedFile[]; // structured (kind-classified, relPath-preserving)
  prompts: CollectedPrompt[]; // legacy flat (.md basenames) for unclassified paths
}

/** One entry from the GitHub contents API (only the fields we read). */
interface ContentsEntry {
  name: string;
  type: string;
  download_url?: string | null;
}

const GITHUB_API_BASE = 'https://api.github.com/repos';
const REQUEST_HEADERS = { 'User-Agent': 'karst', Accept: 'application/vnd.github+json' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Narrow an unknown JSON value into a ContentsEntry, or null if malformed. */
function parseContentsEntry(v: unknown): ContentsEntry | null {
  if (!isRecord(v)) {
    return null;
  }
  const name = v.name;
  const type = v.type;
  if (typeof name !== 'string' || typeof type !== 'string') {
    return null;
  }
  const downloadUrl = v.download_url;
  return {
    name,
    type,
    download_url: typeof downloadUrl === 'string' ? downloadUrl : null,
  };
}

/** Narrow the GitHub contents-API JSON (array = dir listing, object = single file). */
function parseContentsPayload(raw: unknown, repo: string, path: string): ContentsEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .map(parseContentsEntry)
      .filter((e): e is ContentsEntry => e !== null);
  }
  const single = parseContentsEntry(raw);
  if (single === null) {
    throw new ApproachInstallError(
      `unexpected contents-API shape for ${repo}/${path}: not a file or directory listing`,
    );
  }
  return [single];
}

async function fetchContents(
  fetchFn: FetchLike,
  repo: string,
  path: string,
  ref: string,
): Promise<ContentsEntry[]> {
  const url = `${GITHUB_API_BASE}/${repo}/contents/${path}?ref=${ref}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: REQUEST_HEADERS });
  } catch (e) {
    throw new ApproachInstallError(
      `request failed for ${repo}/${path}: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) {
      throw new ApproachInstallError(
        `GitHub contents API returned ${res.status} for ${repo}/${path} (ref=${ref})`,
      );
    }
    throw new ApproachInstallError(
      `GitHub contents API returned ${res.status} for ${repo}/${path}`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new ApproachInstallError(
      `invalid JSON from contents API for ${repo}/${path}: ${(e as Error).message}`,
    );
  }
  return parseContentsPayload(json, repo, path);
}

async function downloadRaw(fetchFn: FetchLike, url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: REQUEST_HEADERS });
  } catch (e) {
    throw new ApproachInstallError(`request failed downloading ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new ApproachInstallError(`download returned ${res.status} for ${url}`);
  }
  try {
    return await res.text();
  } catch (e) {
    throw new ApproachInstallError(`failed reading body from ${url}: ${(e as Error).message}`);
  }
}

/**
 * Recursively walk a contents-API path, downloading every `.md` file found.
 * Names are collected as-is (basename); de-duping across the whole install
 * happens in the caller so a collision between two different `include` paths
 * (or two subdirs) is still caught.
 */
async function collectFromPath(
  fetchFn: FetchLike,
  repo: string,
  ref: string,
  path: string,
): Promise<CollectedPrompt[]> {
  const entries = await fetchContents(fetchFn, repo, path, ref);
  const collected: CollectedPrompt[] = [];

  for (const entry of entries) {
    const childPath = path.length > 0 ? `${path}/${entry.name}` : entry.name;
    if (entry.type === 'dir') {
      const nested = await collectFromPath(fetchFn, repo, ref, childPath);
      collected.push(...nested);
      continue;
    }
    if (entry.type === 'file' && entry.name.endsWith('.md')) {
      if (entry.download_url === null || entry.download_url === undefined) {
        throw new ApproachInstallError(
          `missing download_url for ${repo}/${childPath}`,
        );
      }
      const body = await downloadRaw(fetchFn, entry.download_url);
      collected.push({ name: entry.name, body });
    }
  }

  return collected;
}

/**
 * Recursively walk a contents-API path, downloading every `.md` file found,
 * preserving each file's path *relative to `rootPath`*. Used by the structured
 * collector so a skill folder's subtree (SKILL.md + siblings) keeps its shape.
 */
async function collectSubtree(
  fetchFn: FetchLike,
  repo: string,
  ref: string,
  path: string,
  rootPath: string,
): Promise<{ relFromRoot: string; body: string }[]> {
  const entries = await fetchContents(fetchFn, repo, path, ref);
  const collected: { relFromRoot: string; body: string }[] = [];

  for (const entry of entries) {
    const childPath = path.length > 0 ? `${path}/${entry.name}` : entry.name;
    if (entry.type === 'dir') {
      collected.push(...(await collectSubtree(fetchFn, repo, ref, childPath, rootPath)));
      continue;
    }
    if (entry.type === 'file' && entry.name.endsWith('.md')) {
      if (entry.download_url === null || entry.download_url === undefined) {
        throw new ApproachInstallError(`missing download_url for ${repo}/${childPath}`);
      }
      const body = await downloadRaw(fetchFn, entry.download_url);
      // path relative to the include root, so "skills/tdd" root + "skills/tdd/SKILL.md"
      // yields "SKILL.md".
      const relFromRoot = childPath.slice(rootPath.length).replace(/^[\\/]+/, '');
      collected.push({ relFromRoot, body });
    }
  }

  return collected;
}

/**
 * Collect one git include path. If it classifies to a kind, mirror its subtree
 * under the mapped dest dir (structure-preserving) as `CollectedFile`s; else
 * fall back to the legacy flat markdown walk (basenames → `prompts/`).
 */
async function collectGitInclude(
  fetchFn: FetchLike,
  repo: string,
  ref: string,
  includePath: string,
): Promise<CollectResult> {
  const mapping = classifyPath(includePath);
  if (mapping === null) {
    const prompts = await collectFromPath(fetchFn, repo, ref, includePath);
    return { files: [], prompts };
  }

  const subtree = await collectSubtree(fetchFn, repo, ref, includePath, includePath);
  const files: CollectedFile[] = subtree.map((f) => ({
    kind: mapping.kind,
    relPath: `${mapping.destDir}/${f.relFromRoot}`,
    body: f.body,
  }));
  return { files, prompts: [] };
}

/**
 * De-dupe collected prompts by basename. On a first collision for a given
 * name, both the earlier prompt (already emitted under its original name)
 * and the new one need distinguishing — since prompts are emitted in
 * arrival order, we rename the *new* arrival by prefixing an incrementing
 * counter (e.g. "2-main.md"). Kept simple: never silently overwrite.
 */
function dedupeByName(prompts: CollectedPrompt[]): CollectedPrompt[] {
  const used = new Set<string>();
  const result: CollectedPrompt[] = [];

  for (const prompt of prompts) {
    let name = prompt.name;
    let counter = 2;
    while (used.has(name)) {
      name = `${counter}-${prompt.name}`;
      counter += 1;
    }
    used.add(name);
    result.push({ name, body: prompt.body });
  }

  return result;
}

/**
 * Reject a `collect` path that could escape the temp dir: absolute paths or
 * any segment of `..` (same defensive posture as `assertSafeId` in pkg.ts).
 */
function assertSafeCollectPath(path: string): void {
  if (isAbsolute(path)) {
    throw new ApproachInstallError(`collect path must not be absolute: "${path}"`);
  }
  if (path.split(/[\\/]/).includes('..')) {
    throw new ApproachInstallError(`collect path must not contain "..": "${path}"`);
  }
}

/** Recursively walk a directory on disk, collecting every `.md` file found. */
function walkForMarkdown(dir: string): CollectedPrompt[] {
  const collected: CollectedPrompt[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const childPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...walkForMarkdown(childPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      collected.push({ name: basename(entry.name), body: readFileSync(childPath, 'utf8') });
    }
  }

  return collected;
}

/** Recursively collect `.md` files under `dir`, each with its path relative to `root`. */
function walkSubtree(dir: string, root: string): { relFromRoot: string; body: string }[] {
  const collected: { relFromRoot: string; body: string }[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...walkSubtree(childPath, root));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      collected.push({
        relFromRoot: relative(root, childPath),
        body: readFileSync(childPath, 'utf8'),
      });
    }
  }
  return collected;
}

/**
 * Collect one npm `collect` path from `tempDir`. Classified paths mirror their
 * subtree (structure-preserving `CollectedFile`s); unclassified paths fall back
 * to the legacy flat markdown walk. A path that doesn't exist yields nothing
 * (the command succeeded but produced no such dir). Traversal-guarded.
 */
function collectFromTempPath(tempDir: string, collectPath: string): CollectResult {
  assertSafeCollectPath(collectPath);
  const resolved = join(tempDir, collectPath);
  if (!existsSync(resolved)) {
    return { files: [], prompts: [] };
  }

  const mapping = classifyPath(collectPath);
  if (mapping === null) {
    if (statSync(resolved).isDirectory()) {
      return { files: [], prompts: walkForMarkdown(resolved) };
    }
    if (resolved.endsWith('.md')) {
      return { files: [], prompts: [{ name: basename(resolved), body: readFileSync(resolved, 'utf8') }] };
    }
    return { files: [], prompts: [] };
  }

  if (!statSync(resolved).isDirectory()) {
    return { files: [], prompts: [] };
  }
  const files: CollectedFile[] = walkSubtree(resolved, resolved).map((f) => ({
    kind: mapping.kind,
    relPath: `${mapping.destDir}/${f.relFromRoot.split(/[\\/]/).join('/')}`,
    body: f.body,
  }));
  return { files, prompts: [] };
}

/** Truncate a command's captured output to a short snippet for error messages. */
function outputSnippet(out: string): string {
  const MAX_LEN = 200;
  return out.length > MAX_LEN ? `${out.slice(0, MAX_LEN)}…` : out;
}

/**
 * Build the typed artifact inventory from the collected structured files. A
 * skill's identity is its folder — one artifact per `skills/<name>/` pointing at
 * that folder's `SKILL.md`. Agents/commands are one artifact per `.md` file.
 * Siblings under a skill folder ride along on disk but aren't separate artifacts.
 */
function buildArtifacts(files: readonly CollectedFile[]): ApproachArtifact[] {
  const artifacts: ApproachArtifact[] = [];
  const seenSkillDirs = new Set<string>();

  for (const f of files) {
    if (f.kind === 'skill') {
      // Identity file: skills/<name>/SKILL.md. Emit once per skill dir.
      const segments = f.relPath.split('/');
      const skillDir = segments.slice(0, 2).join('/'); // "skills/<name>"
      if (seenSkillDirs.has(skillDir)) continue;
      seenSkillDirs.add(skillDir);
      artifacts.push({ kind: 'skill', relPath: `${skillDir}/SKILL.md` });
      continue;
    }
    artifacts.push({ kind: f.kind, relPath: f.relPath });
  }
  return artifacts;
}

/** The bare names an `entrypoint` may resolve against, across prompts + artifacts. */
function resolvableNames(
  prompts: readonly CollectedPrompt[],
  artifacts: readonly ApproachArtifact[],
): string[] {
  const names: string[] = [];
  for (const p of prompts) names.push(p.name.replace(/\.md$/, ''));
  for (const a of artifacts) {
    if (a.kind === 'skill') {
      // skills/<name>/SKILL.md → <name>
      names.push(a.relPath.split('/')[1] ?? '');
    } else {
      names.push(basename(a.relPath).replace(/\.md$/, ''));
    }
  }
  return names.filter((n) => n.length > 0);
}

/**
 * Guard the entrypoint against everything collected BEFORE writing the package.
 * The launcher resolves the entrypoint to a real artifact (a skill name, an
 * agent/command file, or a flat prompt); a def whose `entrypoint` matches none
 * would install "clean" yet silently launch bare forever. Fail install instead
 * so the broken package never lands. No entrypoint = fine (built-in/bare).
 */
function assertEntrypointResolvable(
  def: ApproachDef,
  prompts: readonly CollectedPrompt[],
  artifacts: readonly ApproachArtifact[],
): void {
  if (def.entrypoint === undefined || def.entrypoint.length === 0) return;
  const names = resolvableNames(prompts, artifacts);
  if (!names.includes(def.entrypoint)) {
    throw new ApproachInstallError(
      `approach "${def.id}" declares entrypoint "${def.entrypoint}" but nothing collected ` +
        `resolves it (found: ${names.join(', ') || 'none'})`,
    );
  }
}

/**
 * Guard every workflow phase command BEFORE writing the package. A phase's
 * `command` of the form `/<id>:<name>` becomes a plugin slash command at launch
 * only if `commands/<name>.md` was actually fetched — otherwise the orchestrator
 * (`/karst:<id>`) would dispatch to a dangling command that silently does
 * nothing. Fail install instead. Commands in a foreign namespace (not
 * `/<id>:…`) are not ours to verify and are skipped. The karst-generated
 * `/karst:<id>` is produced at materialize time (never a workflow command), so
 * it is not — and need not be — resolvable here.
 */
function assertWorkflowCommandsResolvable(
  def: ApproachDef,
  artifacts: readonly ApproachArtifact[],
): void {
  if (def.workflow === undefined) return;
  const cmdNames = new Set(
    artifacts
      .filter((a) => a.kind === 'command')
      .map((a) => basename(a.relPath).replace(/\.md$/, '')),
  );
  const prefix = `/${def.id}:`;
  for (const phase of def.workflow) {
    if (phase.command === undefined) continue;
    if (!phase.command.startsWith(prefix)) continue; // foreign namespace: not ours to verify
    const name = phase.command.slice(prefix.length);
    if (!cmdNames.has(name)) {
      throw new ApproachInstallError(
        `approach "${def.id}" workflow command "${phase.command}" resolves to no ` +
          `fetched command (found: ${[...cmdNames].join(', ') || 'none'})`,
      );
    }
  }
}

/**
 * Reject a package that would contribute NOTHING to a launch — no method prompt
 * (an `entrypoint` resolving to a collected prompt/artifact), no loadable
 * artifacts (agents/commands/skills), and no `workflow` orchestrator. Such a
 * package installs "clean" yet silently launches with ticket context only (the
 * `extension.ts` "produced no method prompt or loadable artifacts" warning).
 * Fail at install — where the manifest input is entered — instead of deferring
 * to a soft launch-time warning (869e836xh, defect 2).
 *
 * Ordering note: `assertEntrypointResolvable` runs first, so by here a declared
 * `entrypoint` already matched something collected — a set entrypoint therefore
 * implies non-empty `prompts`/`artifacts`. This guard only catches the case
 * where NOTHING was declared or collected.
 */
function assertPackageContributes(
  def: ApproachDef,
  prompts: readonly CollectedPrompt[],
  artifacts: readonly ApproachArtifact[],
): void {
  const hasWorkflow = (def.workflow?.length ?? 0) > 0;
  if (prompts.length > 0 || artifacts.length > 0 || hasWorkflow) return;
  throw new ApproachInstallError(
    `approach "${def.id}" collected nothing installable — its source produced no ` +
      `agents, commands, skills, or prompts, and it declares no workflow. Check the ` +
      `source (git \`include\` / npm \`collect\` paths) and set an \`entrypoint\` that ` +
      `resolves against what is collected.`,
  );
}

/**
 * Assemble collected results into a package and write it structure-preserving.
 * Flat prompts are written under `prompts/<name>` (legacy `readPromptBody`
 * compat + basename entrypoints); structured files at their relPath; the typed
 * `artifacts` inventory records kinds. Shared by the git and npm drivers.
 */
function assembleAndWrite(
  def: ApproachDef,
  baseDir: string,
  results: readonly CollectResult[],
): ApproachPackage {
  const prompts = dedupeByName(results.flatMap((r) => r.prompts));
  const files = results.flatMap((r) => r.files);
  const artifacts = buildArtifacts(files);

  assertEntrypointResolvable(def, prompts, artifacts);
  assertWorkflowCommandsResolvable(def, artifacts);
  assertPackageContributes(def, prompts, artifacts);

  const pkg: ApproachPackage = {
    id: def.id,
    label: def.label,
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...(def.entrypoint !== undefined ? { entrypoint: def.entrypoint } : {}),
    prompts: prompts.map((p) => p.name),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(def.workflow !== undefined ? { workflow: def.workflow } : {}),
  };

  // Sanitize every body BEFORE write: sources are untrusted and may request
  // elevated permissions via frontmatter (bypassPermissions, allowed-tools, …).
  const writeFiles = [
    ...files.map((f) => ({ relPath: f.relPath, body: sanitizeFrontmatter(f.body) })),
    ...prompts.map((p) => ({ relPath: `prompts/${p.name}`, body: sanitizeFrontmatter(p.body) })),
  ];
  writeApproachArtifacts(baseDir, pkg, writeFiles);
  return pkg;
}

/**
 * Install the npm-source branch: run `source.command` in a fresh temp dir,
 * then collect `.md` files from each `source.collect` path (relative to that
 * temp dir) into the package. The temp dir is removed in a `finally` — only
 * after the package has been written to `deps.baseDir`.
 */
function installNpmSource(
  def: ApproachDef,
  source: Extract<ApproachDef['source'], { type: 'npm' }>,
  deps: InstallDeps,
): ApproachPackage {
  const tempDir = mkdtempSync(join(tmpdir(), 'karst-approach-'));
  try {
    const r = deps.runCommand(source.command, tempDir);
    if (r.code !== 0) {
      throw new ApproachInstallError(
        `command "${source.command}" exited with code ${r.code}: ${outputSnippet(r.out)}`,
      );
    }

    const results = source.collect.map((path) => collectFromTempPath(tempDir, path));
    return assembleAndWrite(def, deps.baseDir, results);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Return the shell command an npm-source approach would run, for the Phase-E
 * picker to display before the user confirms installation. `null` for any
 * other source (or no source at all).
 */
export function installCommandFor(def: ApproachDef): string | null {
  return def.source?.type === 'npm' ? def.source.command : null;
}

/**
 * Install an `ApproachDef` into `deps.baseDir` as a neutral `ApproachPackage`.
 * Dispatches on `source.type`: `git` fetches markdown from the GitHub contents
 * API; `npm` runs `source.command` in a temp dir then collects its output. A
 * def with no source (a built-in approach) throws `ApproachInstallError`.
 */
export async function installApproach(
  def: ApproachDef,
  deps: InstallDeps,
): Promise<ApproachPackage> {
  const source = def.source;
  if (source === undefined) {
    throw new ApproachInstallError(`approach "${def.id}" has no source configured`);
  }

  switch (source.type) {
    case 'git': {
      const results = await Promise.all(
        source.include.map((path) =>
          collectGitInclude(deps.fetchFn, source.repo, source.ref, path),
        ),
      );
      return assembleAndWrite(def, deps.baseDir, results);
    }
    case 'npm':
      return installNpmSource(def, source, deps);
    default: {
      const unreachable: never = source;
      throw new ApproachInstallError(
        `approach "${def.id}" has an unrecognized source type: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
