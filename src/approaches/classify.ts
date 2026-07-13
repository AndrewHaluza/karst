import type { ApproachArtifact } from './pkg.js';

/**
 * Map an approach source's `include`/`collect` path to a neutral artifact kind
 * and the package-relative directory its contents mirror into. Agent-agnostic:
 * we only recognize the well-known upstream layouts (Claude/superpowers/GSD),
 * never a "plugin" concept. A path that matches no known layout returns null —
 * its `.md` files fall back to the legacy flat `prompts/` bucket.
 *
 * Layout recognized (first marker segment, case-insensitive) — the marker may
 * be nested under base dirs (a subfolder source like
 * `development-workflows/rpi/.claude/agents`), so we scan for the first segment
 * that IS a marker rather than only looking at segment[0]:
 *   agents  → kind 'agent',   mirror under agents/
 *   commands→ kind 'command', mirror under commands/
 *   skills  → kind 'skill',   mirror under skills/ (each subdir IS a skill)
 *   skills/<name> (a single skill folder) → kind 'skill', mirror under
 *     skills/<name>/ (the folder — segment after the marker — is the identity)
 * Assumption: the base/prefix dirs BEFORE the marker are not themselves named
 * `agents`/`commands`/`skills` (else the earlier one wins the scan).
 */
export interface KindMapping {
  kind: ApproachArtifact['kind'];
  /** Package-relative dir the source subtree mirrors into (no trailing slash). */
  destDir: string;
}

/** Strip a leading `.claude/` and trailing slashes; split into segments. */
function segmentsOf(sourcePath: string): string[] {
  return sourcePath
    .split(/[\\/]/)
    .filter((s) => s.length > 0 && s !== '.claude');
}

const MARKER_KIND = { skills: 'skill', agents: 'agent', commands: 'command' } as const;
type Marker = keyof typeof MARKER_KIND;
function isMarker(s: string): s is Marker {
  return Object.prototype.hasOwnProperty.call(MARKER_KIND, s);
}

export function classifyPath(sourcePath: string): KindMapping | null {
  const segments = segmentsOf(sourcePath);
  const markerIdx = segments.findIndex((s) => isMarker(s.toLowerCase()));
  if (markerIdx === -1) return null;

  const marker = segments[markerIdx]!.toLowerCase() as Marker;
  if (marker === 'skills') {
    // The segment AFTER the marker is the single-skill folder identity; if the
    // marker is the leaf, mirror the whole skills/ dir.
    const name = segments[markerIdx + 1];
    return name ? { kind: 'skill', destDir: `skills/${name}` } : { kind: 'skill', destDir: 'skills' };
  }
  return { kind: MARKER_KIND[marker], destDir: marker };
}
