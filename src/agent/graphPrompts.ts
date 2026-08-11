/**
 * Stable editable prompt identities for the graph approach — Slice-1 Task 7.
 *
 * Two identities (`karst-graph-planner`, `karst-graph-node`) with precedence
 * `project override → packaged prompt`:
 *
 * | Identity            | Packaged path (dist/)                          | Project override path |
 * |---------------------|------------------------------------------------|-----------------------|
 * | karst-graph-planner | .agents/skills/karst-graph-engineering/skills/graph-planner/SKILL.md | <agentsDir>/karst-graph-engineering/graph-planner.md |
 * | karst-graph-node    | .agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md    | <agentsDir>/karst-graph-engineering/graph-node.md    |
 *
 * Editing writes ONLY the project override; Reset deletes only that override
 * and never mutates VSIX bytes; an extension upgrade replaces packaged bytes
 * while preserving overrides. The override files are deliberately tracked user
 * content inside the repository — no `KARST_EXCLUDE_RULES` entry is added for
 * them, exactly as for existing agent prompt overrides (`src/agents/pkg.ts`).
 *
 * The identity is a CLOSED set: an unknown identity is refused with a named
 * error, never guessed. The packaged path composes `BUILT_IN_PACKAGE_PATH`
 * through the built-in overlay seam — `builtIn.js` is imported by exactly that
 * module, and this registry is not a second resolution path for the built-in.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BUILT_IN_PACKAGE_PATH } from '../approaches/withBuiltInApproaches.js';

export const GRAPH_PROMPT_IDENTITIES = ['karst-graph-planner', 'karst-graph-node'] as const;

export type GraphPromptIdentity = (typeof GRAPH_PROMPT_IDENTITIES)[number];

/** The prompt role folder under the packaged skill tree. */
const PACKAGED_ROLES: Readonly<Record<GraphPromptIdentity, string>> = {
  'karst-graph-planner': 'graph-planner',
  'karst-graph-node': 'graph-node',
};

/** The project override directory under `<agentsDir>` (a shared subdir, like
 *  the packaged tree it overrides — several identities per approach). */
const OVERRIDE_DIR = 'karst-graph-engineering';

function requireIdentity(identity: string): GraphPromptIdentity {
  if (!(identity in PACKAGED_ROLES)) {
    throw new Error(`Unknown graph prompt identity "${identity}".`);
  }
  return identity as GraphPromptIdentity;
}

/** The packaged prompt file for an identity, under the extension root's
 *  `dist/` tree (where `copy-assets.mjs` ships the package). */
export function graphPromptPackagedPath(extRoot: string, identity: string): string {
  const role = PACKAGED_ROLES[requireIdentity(identity)];
  return join(extRoot, 'dist', BUILT_IN_PACKAGE_PATH, 'skills', role, 'SKILL.md');
}

/** The project override file for an identity: `<agentsDir>/karst-graph-engineering/<role>.md`. */
export function graphPromptOverridePath(agentsDir: string, identity: string): string {
  const role = PACKAGED_ROLES[requireIdentity(identity)];
  return join(agentsDir, OVERRIDE_DIR, `${role}.md`);
}

export type GraphPromptSource = 'override' | 'packaged';

export interface GraphPromptResolution {
  path: string;
  source: GraphPromptSource;
}

/**
 * Resolve the EFFECTIVE prompt for an identity: the project override when it
 * exists, else the packaged file. The packaged file is never written by any
 * function in this module.
 */
export function resolveGraphPrompt(
  agentsDir: string,
  extRoot: string,
  identity: string,
): GraphPromptResolution {
  const override = graphPromptOverridePath(agentsDir, identity);
  if (existsSync(override)) {
    return { path: override, source: 'override' };
  }
  return { path: graphPromptPackagedPath(extRoot, identity), source: 'packaged' };
}

/** Write ONLY the project override file (creating its directory). The packaged
 *  file is untouched, so an upgrade that replaces packaged bytes preserves
 *  this override. */
export function writeGraphPromptOverride(agentsDir: string, identity: string, body: string): void {
  const override = graphPromptOverridePath(agentsDir, identity);
  mkdirSync(join(agentsDir, OVERRIDE_DIR), { recursive: true });
  writeFileSync(override, body);
}

/** Delete ONLY the project override file. Idempotent: absent override →
 *  no-op, never throws, and never touches the packaged file. */
export function removeGraphPromptOverride(agentsDir: string, identity: string): void {
  const override = graphPromptOverridePath(agentsDir, identity);
  rmSync(override, { force: true });
}
