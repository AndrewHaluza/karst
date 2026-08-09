import type { ApproachDef } from '../manifest/types.js';
import { readApproachPackage, readArtifactBody, readPromptBody } from './pkg.js';

/**
 * Resolve the entrypoint prompt body for a ticket's chosen approach, or null.
 *
 * Looks up `approachId` in the manifest's approach list, reads its
 * `entrypoint`, and returns `prompts/<entrypoint>.md` from the installed
 * package. When no flat prompt exists, the entrypoint is resolved against the
 * package's collected artifact inventory — the same set the install guard
 * (`assertEntrypointResolvable`) validated — and the listed
 * `skills/<entrypoint>/SKILL.md` is read. Returns null — never throws — when
 * the id is missing/unknown, the approach has no entrypoint, the package is
 * not installed, or the entrypoint file is absent. The caller treats null as
 * "launch a bare session".
 */
export function resolveApproachPrompt(
  baseDir: string,
  approaches: readonly ApproachDef[],
  approachId: string | null | undefined,
): string | null {
  if (approachId === null || approachId === undefined || approachId.length === 0) {
    return null;
  }

  const def = approaches.find((a) => a.id === approachId);
  if (def === undefined || def.entrypoint === undefined || def.entrypoint.length === 0) {
    return null;
  }

  // Load-bearing catch: a manifest-authored `entrypoint` is untrusted content
  // and could contain a traversal segment (e.g. "../../etc/passwd"), which
  // `readPromptBody`'s `assertSafeId` guard rejects by throwing. Swallow it to a
  // bare launch — do NOT simplify this away.
  try {
    const flat = readPromptBody(baseDir, approachId, `${def.entrypoint}.md`);
    if (flat !== null) return flat;
  } catch {
    return null;
  }

  // Skill-folder entrypoints (e.g. "writing-plans") store their content at
  // skills/<name>/SKILL.md, not prompts/<name>.md. Resolve the bare name against
  // the artifact inventory — the same inventory `assertEntrypointResolvable`
  // validated at install — so an entrypoint that resolved to an agent/command
  // basename is never answered with a same-named skill's body. Read the listed
  // artifact, never a guess: the file must exist for the inventory to matter.
  try {
    const pkg = readApproachPackage(baseDir, approachId);
    const skillRel = `skills/${def.entrypoint}/SKILL.md`;
    const resolved = pkg?.artifacts?.find(
      (a) => a.kind === 'skill' && a.relPath === skillRel,
    );
    if (resolved === undefined) return null;
    return readArtifactBody(baseDir, approachId, resolved.relPath);
  } catch {
    return null;
  }
}
