/**
 * Future-field guards (@arch:FIELDCHK, @arch:CLI-21). Everything here derives
 * from the section table, the section schemas and the rich manifest fixture:
 * no hand list of fields. A field added later fails one of these tests until
 * it reaches the tool, the write overlay, the diff and the protection rule.
 */
import { dump } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { parseManifestText } from '../../manifest/load.js';
import { SECTION_OF, SECTION_PROTECTED } from '../../manifest/sectionTable.js';
import type { Manifest } from '../../manifest/types.js';
import type { JsonSchema } from '../jsonSchema.js';
import { MANIFEST_SECTIONS, MANIFEST_SECTION_SCHEMAS, sectionFields } from '../manifestSchemas/index.js';
import type { ManifestSection } from '../manifestSchemas/index.js';
import { richDraftManifest } from '../manifestSchemas/fixtures/richManifest.js';
import { buildEdits } from './build.js';
import type { LoadText } from './build.js';
import { splitProtected } from './protection.js';
import { SETUP_EDIT_TOOLS, SETUP_EDIT_TOOL_NAMES } from './tools.js';

type Tree = Record<string, unknown>;
const isTree = (v: unknown): v is Tree => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const loadText: LoadText = (text) => {
  try {
    const r = parseManifestText(text, '/p/karst.yml');
    return { ok: true, manifest: r.manifest, codedWarnings: r.codedWarnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};
const tryLoad = (raw: Tree): Manifest | undefined => {
  const r = loadText(dump(raw));
  return r.ok ? r.manifest : undefined;
};
const json = (m: unknown): unknown => JSON.parse(JSON.stringify(m));

/** The schema leaf patterns (`a.*.b`): a leaf is a scalar, an array or a mapping with no listed keys. */
function schemaLeaves(schema: JsonSchema, root: JsonSchema, prefix: string, out: Set<string>): void {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace('#/$defs/', '');
    return schemaLeaves(root.$defs![name]!, root, prefix, out);
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives !== undefined) {
    const real = alternatives.filter((a) => a.type !== 'null');
    for (const alt of real.length > 0 ? real : alternatives) schemaLeaves(alt, root, prefix, out);
    return;
  }
  if (schema.type === 'string' && schema.enum !== undefined && schema.enum.length === 0) return; // NEVER
  if (schema.type === 'object' && (schema.properties !== undefined || isTree(schema.additionalProperties))) {
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      schemaLeaves(sub, root, prefix === '' ? key : `${prefix}.${key}`, out);
    }
    if (isTree(schema.additionalProperties)) {
      schemaLeaves(schema.additionalProperties as JsonSchema, root, prefix === '' ? '*' : `${prefix}.*`, out);
    }
    return;
  }
  if (prefix !== '') out.add(prefix);
}

/** The leaf paths of a raw tree as segment lists: a scalar, an array or an empty mapping. */
function treeLeaves(tree: unknown, path: string[], out: string[][]): string[][] {
  if (isTree(tree) && Object.keys(tree).length > 0) {
    for (const [k, v] of Object.entries(tree)) treeLeaves(v, [...path, k], out);
  } else if (path.length > 0) out.push(path);
  return out;
}

/** `service` and `services.<name>` are one ServiceDef: both spell the same leaf. */
const canon = (segments: readonly string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === 'services' && segments[i - 2] === 'repositories') {
      out.push('service');
      i += 1;
    } else out.push(segments[i]!);
  }
  // Per-process rows share one shape: `processes.<role>.x` is `processes.*.x`.
  if (out[0] === 'processes' && out.length > 1) out[1] = '*';
  // Every capability slot has one shape: `agentPresets.<n>.slots.<cap>.x` is `...slots.*.x`.
  if (out[0] === 'agentPresets' && out[2] === 'slots' && out.length > 3) out[3] = '*';
  return out;
};

const matches = (pattern: string, path: readonly string[]): boolean => {
  const parts = canon(pattern.split('.'));
  const cpath = canon(path);
  return parts.length === cpath.length && parts.every((p, i) => p === '*' || p === cpath[i]);
};

function getAt(tree: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => (isTree(node) ? node[key] : undefined), tree);
}

/** `tree` without the key at `path`. */
function without(tree: Tree, path: readonly string[]): Tree {
  const out = clone(tree);
  const parent = getAt(out, path.slice(0, -1));
  if (isTree(parent)) delete parent[path[path.length - 1]!];
  return out;
}

/** A nested patch that sets `value` at `path`. */
function patchAt(path: readonly string[], value: unknown): Tree {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Tree;
}

const RICH = (): Tree => richDraftManifest();
const LEAVES = treeLeaves(RICH(), [], []);
const sectionOf = (path: readonly string[]): ManifestSection => SECTION_OF[path[0] as keyof Manifest];
const setTool = (path: readonly string[]): string => `set-${sectionOf(path)}`;

/**
 * Leaves the loader accepts but write.ts deliberately never writes (deprecated,
 * replaced by another key). A leaf joins this list only with a reason.
 */
const NOT_WRITTEN: Readonly<Record<string, string>> = {
  'processes.*.preset': 'deprecated (§7.4): write.ts drops it; activeAgentPreset and slots replace it',
};

/** Legacy spellings the rich manifest cannot carry beside their canonical key. */
const ALIASES: Readonly<Record<string, string>> = {
  defaultAgentPreset: 'activeAgentPreset',
  // The gate is one of two exclusive variants; the command variant is instanced by `uat.gates`.
  'uat.testerVerifier.command': 'uat.gates',
  'uat.testerVerifier.args': 'uat.gates',
};

const SCHEMA_LEAVES: string[] = MANIFEST_SECTIONS.flatMap((section) => {
  const schema = MANIFEST_SECTION_SCHEMAS[section];
  const out = new Set<string>();
  schemaLeaves(schema, schema, '', out);
  return [...out];
}).filter((leaf) => !(canon(leaf.split('.')).join('.') in NOT_WRITTEN));

describe('tool coverage', () => {
  it('has exactly one set tool per section, with every key of the section as an input property', () => {
    for (const section of MANIFEST_SECTIONS) {
      const tools = SETUP_EDIT_TOOLS.filter((t) => t.section === section);
      expect(tools.map((t) => t.name), section).toEqual([`set-${section}`]);
      expect(Object.keys(tools[0]!.inputSchema.properties ?? {}).sort(), section).toEqual([...sectionFields(section)].sort());
    }
  });

  it('names every tool once', () => {
    expect(new Set(SETUP_EDIT_TOOL_NAMES).size).toBe(SETUP_EDIT_TOOL_NAMES.length);
  });

  it('reaches every schema leaf through a tool input, and the rich manifest instances every leaf', () => {
    expect(SCHEMA_LEAVES.length).toBeGreaterThan(100);
    const missing: string[] = [];
    for (const leaf of SCHEMA_LEAVES) {
      const top = leaf.split('.')[0]!;
      expect(SETUP_EDIT_TOOLS.some((t) => t.inputSchema.properties?.[top] !== undefined), leaf).toBe(true);
      if (leaf in ALIASES) continue;
      if (!LEAVES.some((p) => matches(leaf, p) || matches(`${leaf}.*`, p))) missing.push(leaf);
    }
    expect(missing, 'leaves with no instance in the rich manifest').toEqual([]);
  });

  it('has a schema leaf for every leaf of the rich manifest', () => {
    for (const path of LEAVES) {
      const hit = SCHEMA_LEAVES.some((l) => matches(l, path));
      expect(hit, `no schema leaf for ${path.join('.')}`).toBe(true);
    }
  });
});

describe('round trip through the tool, the write path and the loader', () => {
  const expected = tryLoad(RICH());

  it('loads the rich manifest', () => {
    expect(expected).toBeDefined();
  });

  it('writes every section of the rich manifest into a bare base', () => {
    const base = RICH();
    for (const section of MANIFEST_SECTIONS) for (const key of sectionFields(section)) delete base[key];
    const bare: Tree = { id: 'rich', host: '127.0.0.1', portRange: [4000, 4100], baselineBranch: 'develop', repositories: { r: { repoPath: '/r' } } };
    const ops = MANIFEST_SECTIONS.map((section, i) => ({
      id: `o${i}`,
      tool: `set-${section}`,
      input: Object.fromEntries(sectionFields(section).filter((k) => RICH()[k] !== undefined).map((k) => [k, k === 'repositories' ? { ...(RICH().repositories as Tree), r: null } : RICH()[k]])),
    }));
    const built = buildEdits(dump(bare), ops, { firstSetup: true }, loadText);
    expect(built.ok ? '' : built.reason).toBe('');
    if (!built.ok) return;
    expect(json(built.manifest)).toEqual(json(expected));
    expect(base).toBeDefined();
  });

  it('sets every leaf of the rich manifest on a base that lacks it, and the diff names the path', () => {
    let tested = 0;
    for (const path of LEAVES) {
      const base = without(RICH(), path);
      if (tryLoad(base) === undefined) continue;
      const value = getAt(RICH(), path);
      const built = buildEdits(dump(base), [{ id: 'o', tool: setTool(path), input: patchAt(path, value) }], { firstSetup: true }, loadText);
      expect(built.ok ? '' : built.reason, path.join('.')).toBe('');
      if (!built.ok) continue;
      expect(json(built.manifest), path.join('.')).toEqual(json(expected));
      // A value the loader normalizes away (its default) leaves no change; any other value must show in the diff.
      const baseLoaded = tryLoad(base);
      const isDefault = JSON.stringify(getAt(json(baseLoaded), path)) === JSON.stringify(getAt(json(built.manifest), path));
      const listed = built.changes.some((c) => c.path === path.join('.') || c.path.startsWith(`${path.join('.')}.`));
      expect(listed || isDefault, `diff misses ${path.join('.')}`).toBe(true);
      tested += 1;
    }
    expect(tested).toBeGreaterThan(LEAVES.length / 2);
  });

  it('removes every leaf with a null patch, as deleting the key from the raw tree does', () => {
    let tested = 0;
    for (const path of LEAVES) {
      const stripped = tryLoad(without(RICH(), path));
      if (stripped === undefined) continue;
      const built = buildEdits(dump(RICH()), [{ id: 'o', tool: setTool(path), input: patchAt(path, null) }], { firstSetup: true }, loadText);
      expect(built.ok ? '' : built.reason, path.join('.')).toBe('');
      if (!built.ok) continue;
      expect(json(built.manifest), path.join('.')).toEqual(json(stripped));
      tested += 1;
    }
    expect(tested).toBeGreaterThan(LEAVES.length / 2);
  });
});

describe('protection', () => {
  it('has one decision for every section and every top-level key', () => {
    for (const section of MANIFEST_SECTIONS) expect(typeof SECTION_PROTECTED[section]).toBe('boolean');
    for (const key of Object.keys(SECTION_OF)) expect(SECTION_PROTECTED[SECTION_OF[key as keyof Manifest]], key).toBeDefined();
  });

  it('lists a change in the protected block exactly when its section is protected', () => {
    for (const path of LEAVES) {
      const change = { path: path.join('.'), before: undefined, after: 1 };
      const { protectedChanges } = splitProtected([change]);
      expect(protectedChanges.length === 1, path.join('.')).toBe(SECTION_PROTECTED[sectionOf(path)]);
    }
  });
});
