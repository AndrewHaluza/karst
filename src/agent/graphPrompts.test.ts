/**
 * Prompt override identities for the graph approach — Slice-1 Task 7.
 *
 * Two stable editable prompt identities (`karst-graph-planner`,
 * `karst-graph-node`) with precedence `project override → packaged prompt`.
 * Editing writes ONLY the project override under `<agentsDir>`; Reset deletes
 * only that override and never mutates the VSIX bytes; an extension upgrade
 * replaces packaged bytes while preserving overrides. The override files are
 * deliberately tracked user content — no KARST_EXCLUDE_RULES entry for them,
 * exactly as for existing agent prompt overrides.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRAPH_PROMPT_IDENTITIES,
  graphPromptOverridePath,
  graphPromptPackagedPath,
  resolveGraphPrompt,
  writeGraphPromptOverride,
  removeGraphPromptOverride,
} from './graphPrompts.js';

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('graph prompt identities (Slice-1 T7)', () => {
  it('registers exactly the two stable identities with their packaged/override paths', () => {
    const agentsDir = makeDir('karst-graph-prompts-');
    const extRoot = makeDir('karst-graph-ext-');

    expect(GRAPH_PROMPT_IDENTITIES).toEqual(['karst-graph-planner', 'karst-graph-node']);
    expect(graphPromptPackagedPath(extRoot, 'karst-graph-planner')).toBe(
      join(extRoot, 'dist', '.agents/skills/karst-graph-engineering/skills/graph-planner/SKILL.md'),
    );
    expect(graphPromptPackagedPath(extRoot, 'karst-graph-node')).toBe(
      join(extRoot, 'dist', '.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md'),
    );
    expect(graphPromptOverridePath(agentsDir, 'karst-graph-planner')).toBe(
      join(agentsDir, 'karst-graph-engineering', 'graph-planner.md'),
    );
    expect(graphPromptOverridePath(agentsDir, 'karst-graph-node')).toBe(
      join(agentsDir, 'karst-graph-engineering', 'graph-node.md'),
    );
  });

  it('resolves the packaged prompt when no override exists', () => {
    const agentsDir = makeDir('karst-graph-prompts-');
    const extRoot = makeDir('karst-graph-ext-');

    const resolved = resolveGraphPrompt(agentsDir, extRoot, 'karst-graph-planner');
    expect(resolved.source).toBe('packaged');
    expect(resolved.path).toBe(graphPromptPackagedPath(extRoot, 'karst-graph-planner'));
  });

  it('override wins when the project has written one', () => {
    const agentsDir = makeDir('karst-graph-prompts-');
    const extRoot = makeDir('karst-graph-ext-');

    writeGraphPromptOverride(agentsDir, 'karst-graph-planner', '# my planner prompt');
    const resolved = resolveGraphPrompt(agentsDir, extRoot, 'karst-graph-planner');
    expect(resolved.source).toBe('override');
    expect(resolved.path).toBe(graphPromptOverridePath(agentsDir, 'karst-graph-planner'));
    expect(readFileSync(resolved.path, 'utf8')).toBe('# my planner prompt');
  });

  it('reset restores the packaged prompt', () => {
    const agentsDir = makeDir('karst-graph-prompts-');
    const extRoot = makeDir('karst-graph-ext-');

    writeGraphPromptOverride(agentsDir, 'karst-graph-planner', '# override');
    removeGraphPromptOverride(agentsDir, 'karst-graph-planner');
    const resolved = resolveGraphPrompt(agentsDir, extRoot, 'karst-graph-planner');
    expect(resolved.source).toBe('packaged');
    expect(resolved.path).toBe(graphPromptPackagedPath(extRoot, 'karst-graph-planner'));
  });

  it('an extension upgrade replaces packaged bytes while preserving the override', () => {
    const agentsDir = makeDir('karst-graph-prompts-');
    const oldExtRoot = makeDir('karst-graph-ext-');
    const newExtRoot = makeDir('karst-graph-ext-');

    writeGraphPromptOverride(agentsDir, 'karst-graph-node', '# project node prompt');
    // The extension moved to a new install root (upgrade): packaged bytes are
    // new, the override must still win.
    const resolved = resolveGraphPrompt(agentsDir, newExtRoot, 'karst-graph-node');
    expect(resolved.source).toBe('override');
    expect(readFileSync(resolved.path, 'utf8')).toBe('# project node prompt');
  });

  it('editing never writes the packaged file', () => {
    const agentsDir = makeDir('karst-graph-prompts-');
    const extRoot = makeDir('karst-graph-ext-');
    const packaged = graphPromptPackagedPath(extRoot, 'karst-graph-planner');

    writeGraphPromptOverride(agentsDir, 'karst-graph-planner', '# override');
    expect(existsSync(packaged)).toBe(false); // packaged bytes untouched

    // A packaged file that DOES exist (as shipped) is never mutated either.
    mkdirSync(join(packaged, '..'), { recursive: true });
    writeFileSync(packaged, '# shipped bytes');
    removeGraphPromptOverride(agentsDir, 'karst-graph-planner');
    expect(readFileSync(packaged, 'utf8')).toBe('# shipped bytes');
  });

  it('remove is idempotent and never touches the packaged file', () => {
    const agentsDir = makeDir('karst-graph-prompts-');
    const extRoot = makeDir('karst-graph-ext-');
    removeGraphPromptOverride(agentsDir, 'karst-graph-node');
    expect(resolveGraphPrompt(agentsDir, extRoot, 'karst-graph-node').source).toBe('packaged');
  });

  it('refuses an identity outside the closed set', () => {
    const agentsDir = makeDir('karst-graph-prompts-');
    expect(() => resolveGraphPrompt(agentsDir, agentsDir, 'karst-graph-reviewer' as never)).toThrow(
      /Unknown graph prompt identity/,
    );
    expect(() => writeGraphPromptOverride(agentsDir, '' as never, 'x')).toThrow(
      /Unknown graph prompt identity/,
    );
  });
});
