import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Marker embedded in every artifact karst GENERATES into a session directory
 * (the `/karst:<id>` orchestrator command, the workflow skill). A markdown
 * comment, so it is invisible wherever the body is rendered.
 *
 * It exists because the destination is shared: the `karst` plugin dir is named
 * for the plugin, not the approach, and a worktree outlives the approach and
 * the stage it was first launched under. Guarding those writes with "does the
 * path exist" conflated two different files — one karst wrote on an earlier
 * launch (must be REPLACED, its inputs have changed) and one the repository
 * checked in (must be LEFT ALONE, it is not ours). The stamp separates them.
 */
export const GENERATED_STAMP = '<!-- karst:generated — rewritten on every launch -->';

/** Prefix a rendered body with the generated marker. */
export function withStamp(body: string): string {
  return `${GENERATED_STAMP}\n${body}`;
}

/** True only for a readable file carrying the generated marker. */
export function isGeneratedArtifact(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(GENERATED_STAMP);
  } catch {
    return false;
  }
}

/**
 * Write a karst-generated artifact, creating parent dirs. Refuses to clobber a
 * file karst did not generate (a repository's own checked-in command/skill at
 * the same name) and reports that refusal via `false` so the caller can decide
 * whether it still owns the path for cleanup.
 */
export function writeGeneratedArtifact(path: string, content: string): boolean {
  if (existsSync(path) && !isGeneratedArtifact(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}
