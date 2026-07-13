import type { ApproachDef } from '../manifest/types.js';
import { readPromptBody } from './pkg.js';

/**
 * Resolve the entrypoint prompt body for a ticket's chosen approach, or null.
 *
 * Looks up `approachId` in the manifest's approach list, reads its
 * `entrypoint`, and returns `prompts/<entrypoint>.md` from the installed
 * package. Returns null — never throws — when the id is missing/unknown, the
 * approach has no entrypoint, the package is not installed, or the entrypoint
 * file is absent. The caller treats null as "launch a bare session".
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
    return readPromptBody(baseDir, approachId, `${def.entrypoint}.md`);
  } catch {
    return null;
  }
}
