import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { sanitizeFrontmatter } from '../approaches/sanitize.js';

/**
 * File-backed agent I/O: each single-subagent lives as one markdown file at
 * `<agentsDir>/<name>.md`. Mirrors the traversal-guard + I/O style of
 * `src/approaches/pkg.ts`, but agent files have no separate metadata sidecar —
 * an optional `description` is parsed from a leading YAML frontmatter block.
 */
export interface AgentFile {
  name: string; // filename stem (unique id), e.g. "reviewer"
  description?: string; // parsed from leading frontmatter `description:` scalar, if any
  body: string; // full file contents (frontmatter + system prompt)
}

/** Thrown when an agent `name` could escape `agentsDir` (path traversal guard). */
export class AgentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentFileError';
  }
}

/**
 * Reject any name that could escape the agents directory: path separators,
 * `..` segments, or an absolute path. Mirrors `assertSafeId` in
 * `src/approaches/pkg.ts`.
 */
function assertSafeName(name: string): void {
  if (name.length === 0) {
    throw new AgentFileError('agent name must be a non-empty string');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new AgentFileError(`agent name must not contain a path separator: "${name}"`);
  }
  if (name === '..' || name.split('/').includes('..')) {
    throw new AgentFileError(`agent name must not contain "..": "${name}"`);
  }
  if (isAbsolute(name)) {
    throw new AgentFileError(`agent name must not be an absolute path: "${name}"`);
  }
}

function agentPath(agentsDir: string, name: string): string {
  assertSafeName(name);
  return join(agentsDir, `${name}.md`);
}

/**
 * Parse the `description:` scalar from a leading `---`-delimited frontmatter
 * block. Small and defensive (no yaml lib), mirroring sanitize.ts's line-scan
 * approach. Returns undefined when there's no frontmatter or no top-level
 * `description` key.
 */
function parseDescription(body: string): string | undefined {
  if (!body.startsWith('---')) return undefined;

  const lines = body.split('\n');
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return undefined; // unterminated block

  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]!;
    if (/^\s/.test(line)) continue; // only top-level scalars
    const match = /^description\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    if (raw.length === 0) return undefined;
    const unquoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
    return unquoted ? unquoted[1]! : raw;
  }
  return undefined;
}

/**
 * List local agent files under `agentsDir`, sorted by name. `[]` when the
 * directory doesn't exist. Skips subdirectories, non-`.md` files, and any
 * file that fails to read (rather than throwing the whole list).
 */
export function listAgentFiles(agentsDir: string): AgentFile[] {
  if (!existsSync(agentsDir)) {
    return [];
  }

  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const result: AgentFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -'.md'.length);
    try {
      const body = readFileSync(join(agentsDir, entry.name), 'utf8');
      const description = parseDescription(body);
      result.push({ name, body, ...(description !== undefined ? { description } : {}) });
    } catch {
      // Skip a file that can't be read rather than failing the whole list.
      continue;
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** The values of the optional `context:` frontmatter key. Anything else = full context. */
export type ProfileContext = 'minimal';

export interface ParsedProfileContext {
  /** `'minimal'` only for an exact `context: minimal`; undefined = full context (no key, or an unknown value). */
  context?: ProfileContext;
  /** The raw value of a `context:` key that is not a known value — the caller reports it as a warning. */
  unknown?: string;
}

/**
 * Parse the optional top-level `context:` scalar from a profile's leading
 * frontmatter block (same line-scan as `parseDescription`). `context: minimal`
 * asks a headless lane to drop skills and subagents (`@arch:PROFILE`). No key
 * or any other value = full context; an unknown value is returned in `unknown`.
 */
export function parseProfileContext(body: string): ParsedProfileContext {
  if (!body.startsWith('---')) return {};
  const lines = body.split('\n');
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]!;
    if (/^\s/.test(line)) continue;
    const match = /^context\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    const value = (/^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw))?.[1] ?? raw;
    if (value === 'minimal') return { context: 'minimal' };
    return { unknown: value };
  }
  return {};
}

/**
 * The context a process runs with, from its resolved profile body. An
 * unreadable / absent profile (`body` undefined) and an unknown value both keep
 * full context (undefined); the unknown value is reported through `warn`.
 */
export function resolveProfileContext(
  name: string | undefined,
  body: string | undefined,
  warn: (message: string) => void,
): ProfileContext | undefined {
  if (body === undefined) return undefined;
  const parsed = parseProfileContext(body);
  if (parsed.unknown !== undefined) {
    warn(
      `[process] profile "${name ?? '(unnamed)'}": unknown \`context: ${parsed.unknown}\` — only \`minimal\` is supported; keeping full context`,
    );
  }
  return parsed.context;
}

/** Read a single agent file by name. Returns null when it doesn't exist. */
export function readAgentFile(agentsDir: string, name: string): AgentFile | null {
  const path = agentPath(agentsDir, name);
  if (!existsSync(path)) {
    return null;
  }
  const body = readFileSync(path, 'utf8');
  const description = parseDescription(body);
  return { name, body, ...(description !== undefined ? { description } : {}) };
}

/**
 * Write an agent file's body to `<agentsDir>/<name>.md`, creating the
 * directory if needed. Runs `sanitizeFrontmatter` first — untrusted content
 * (e.g. materialized from an approach artifact) may request elevated
 * permissions, so dangerous frontmatter keys are stripped before landing on
 * disk.
 */
export function writeAgentFile(agentsDir: string, name: string, body: string): void {
  const path = agentPath(agentsDir, name);
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path, sanitizeFrontmatter(body));
}

/** Remove an agent file. Idempotent: absent file → no-op, never throws. */
export function removeAgentFile(agentsDir: string, name: string): void {
  const path = agentPath(agentsDir, name);
  rmSync(path, { force: true });
}
