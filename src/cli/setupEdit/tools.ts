/**
 * The typed setup tools (@arch:CLI-21). Generated from the section table: one
 * `set-<section>` tool per section, plus the repository tools and `fix`. A tool
 * input is a sparse patch (or a small envelope for the repository tools); a key
 * set to `null` removes the key. No tool carries a field list or a schema of
 * its own: every check runs the unchanged section schemas on the patched tree.
 */

import type { JsonSchema } from '../jsonSchema.js';
import { MANIFEST_SECTIONS, MANIFEST_SECTION_SCHEMAS, sectionFields } from '../manifestSchemas/index.js';
import type { ManifestSection } from '../manifestSchemas/index.js';

export const SET_PREFIX = 'set-';

export type SetupEditToolName = string;

export interface SetupEditTool {
  /** The setup sub-command: `set-general`, `add-repo`, `fix`. */
  name: SetupEditToolName;
  summary: string;
  /** The section a `set-<section>` tool patches; absent for the repository tools and `fix`. */
  section?: ManifestSection;
  /** The JSON shape of the tool input, as `karst schema setup <tool>` prints it. */
  inputSchema: JsonSchema;
}

const STRING_SCHEMA: JsonSchema = { type: 'string', minLength: 1 };
const PATCH_SCHEMA: JsonSchema = { type: 'object', description: 'A sparse patch; a key set to null is removed.' };

const object = (properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

function setSectionTool(section: ManifestSection): SetupEditTool {
  const schema = MANIFEST_SECTION_SCHEMAS[section];
  const properties = Object.fromEntries(
    sectionFields(section).map((key) => [key, schema.properties?.[key] ?? {}]),
  );
  return {
    name: `${SET_PREFIX}${section}`,
    section,
    summary: `Patch the ${section} section (${sectionFields(section).join(', ')}). A key set to null is removed.`,
    inputSchema: { type: 'object', description: 'A sparse patch of the section; a key set to null is removed.', properties },
  };
}

const REPO_TOOLS: readonly SetupEditTool[] = [
  {
    name: 'add-repo',
    summary: 'Add a repository. The repo value is a repository object.',
    inputSchema: object({ name: STRING_SCHEMA, repo: { type: 'object' } }, ['name', 'repo']),
  },
  {
    name: 'set-repo',
    summary: 'Patch one repository. A key set to null is removed.',
    inputSchema: object({ name: STRING_SCHEMA, patch: PATCH_SCHEMA }, ['name', 'patch']),
  },
  {
    name: 'remove-repo',
    summary: 'Remove one repository.',
    inputSchema: object({ name: STRING_SCHEMA }, ['name']),
  },
  {
    name: 'set-service',
    summary: 'Patch the service of a repository. Give name to patch one entry of a services map. A key set to null is removed.',
    inputSchema: object({ repo: STRING_SCHEMA, name: STRING_SCHEMA, patch: PATCH_SCHEMA }, ['repo', 'patch']),
  },
  {
    name: 'remove-service',
    summary: 'Remove the service of a repository. Give name to remove one entry of a services map.',
    inputSchema: object({ repo: STRING_SCHEMA, name: STRING_SCHEMA }, ['repo']),
  },
  {
    name: 'fix',
    summary: 'Apply the host-built fix for a known readiness item code.',
    inputSchema: object({ code: STRING_SCHEMA }, ['code']),
  },
];

export const SETUP_EDIT_TOOLS: readonly SetupEditTool[] = [
  ...MANIFEST_SECTIONS.map(setSectionTool),
  ...REPO_TOOLS,
];

export const SETUP_EDIT_TOOL_NAMES: readonly string[] = SETUP_EDIT_TOOLS.map((t) => t.name);

export function findEditTool(name: string): SetupEditTool | undefined {
  return SETUP_EDIT_TOOLS.find((t) => t.name === name);
}

/** One recorded tool call: the host replays the list, in order, on the latest karst.yml. */
export interface EditOp {
  id: string;
  tool: string;
  input: unknown;
}
