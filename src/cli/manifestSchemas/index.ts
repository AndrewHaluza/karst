/**
 * One JSON Schema per manifest section (@arch:CLI-03, @arch:FIELDCHK).
 *
 * A section is a Settings tab (`SECTION_FIELDS`), plus `project` for the keys no
 * tab claims (`id`, `resilience`, `artifacts`, `agentSandbox`, `sandboxMemory`,
 * `sandboxLimits`, `analysis`). A schema validates a manifest object that holds
 * that section's fields; fields of other sections are ignored. The hand-written
 * validator (`validateManifest`) stays the authority: `conformance.test.ts`
 * proves each schema accepts and refuses the same documents.
 */

import type { JsonSchema } from '../jsonSchema.js';
import { validateJson } from '../jsonSchema.js';
import { SECTION_FIELDS, SETTINGS_SECTIONS } from '../../ui/settings/sections.js';
import type { SettingsSection } from '../../ui/settings/sections.js';
import { AGENTS_SCHEMA } from './agents.js';
import { APPROACHES_SCHEMA } from './approaches.js';
import { AUTOPILOT_SCHEMA } from './autopilot.js';
import { GENERAL_SCHEMA } from './general.js';
import { GIT_SCHEMA } from './git.js';
import { PROJECT_SCHEMA } from './project.js';
import { QUALITY_SCHEMA } from './quality.js';
import { REPOSITORIES_SCHEMA } from './repositories.js';
import { TICKETING_SCHEMA } from './ticketing.js';

export type ManifestSection = SettingsSection | 'project';

export const MANIFEST_SECTIONS: readonly ManifestSection[] = [...SETTINGS_SECTIONS, 'project'];

export const MANIFEST_SECTION_SCHEMAS: Readonly<Record<ManifestSection, JsonSchema>> = {
  general: GENERAL_SCHEMA,
  git: GIT_SCHEMA,
  services: REPOSITORIES_SCHEMA,
  approaches: APPROACHES_SCHEMA,
  agents: AGENTS_SCHEMA,
  ticketing: TICKETING_SCHEMA,
  quality: QUALITY_SCHEMA,
  autopilot: AUTOPILOT_SCHEMA,
  project: PROJECT_SCHEMA,
};

/** The manifest keys each section owns: the Settings tab fields, or the unclaimed keys for `project`. */
export function sectionFields(section: ManifestSection): readonly string[] {
  if (section === 'project') return Object.keys(PROJECT_SCHEMA.properties ?? {});
  return SECTION_FIELDS[section];
}

/**
 * Semantic rules `validateManifest` enforces and a JSON Schema cannot express.
 * The schemas are NOT a substitute for the validator on these; a tool that
 * writes a section must still run the validator (tool docs name this list).
 */
export const VALIDATOR_ONLY_RULES: readonly string[] = [
  'Repository ids are distinct case-insensitively (assertDistinctRepoIds).',
  'A dependsOn target names a declared repository or service, and its port names a port slot of the target.',
  'A service does not depend on itself.',
  'Port slot names are unique per service; port env vars are unique per service; bind env vars are unique per dependsOn entry.',
  'A service portRange and the manifest portRange have min <= max.',
  'The dependsOn graph is acyclic (validateGraph).',
  'A dependsOn edge does not cross host placement (assertHostPlacedLoopback).',
  'A service with sandbox: host needs a loopback manifest host (127.0.0.1, localhost or ::1).',
  'Repositories that share one repoPath share one baseline branch (assertSharedRepoBaselineBranches).',
  'sandbox.setupHosts entries are valid host names (setupHostError).',
  'Label, terminal-name, commit, pull-request and branch templates use known placeholders (validateLabelTemplate, validateArtifactTemplate, validateBranchTemplate).',
  'Approach ids are unique and at most one approach is recommended.',
  'An approach graph block has no hoisted planner, profiles, commands or limits key beside it; maxExpertRuns >= maxReplans + 1.',
  'Output globs are safe repo-relative paths (globFault).',
  'activeAgentPreset and defaultAgentPreset are not both set; every preset reference names a defined preset.',
  'review.repositories keys and uat.repositories keys name declared repositories; review.stallDetection.repeatedFindingRounds <= review.maxFixAttempts.',
  'uat.origins entries parse as absolute URLs with an origin.',
  'The legacy services map, process rows and old keys are migrated before validation (migrateLegacyManifest, foldProcessRows).',
];

/** First schema error over every section, or `null` when all sections accept `manifest`. */
export function validateManifestSections(manifest: unknown): { section: ManifestSection; error: string } | null {
  for (const section of MANIFEST_SECTIONS) {
    const error = validateJson(MANIFEST_SECTION_SCHEMAS[section], manifest);
    if (error !== null) return { section, error };
  }
  return null;
}
