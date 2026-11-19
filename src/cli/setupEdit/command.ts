/**
 * The typed setup tools as CLI verbs: `karst setup <tool>` with one JSON object
 * (`--file <path>` or stdin; no argv encoding of nested values). A call checks
 * its input, replays the pending edit list plus the new op on the latest
 * karst.yml with the same build the host runs, and only then appends the op.
 * A schema error returns `{ok:false, field, reason}`; a loader error returns
 * the real loader message. Setup-only: a call outside a setup session is refused.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseManifestText } from '../../manifest/load.js';
import type { Manifest } from '../../manifest/types.js';
import { editsDir, readEditOps, writeEditOp, withdrawEditOp } from '../../setup/editOps.js';
import type { EditOpFile } from '../../setup/editOps.js';
import { resolveSetupOutboxDir } from '../../setup/outbox.js';
import { MAX_SETUP_PROPOSAL_BYTES } from '../../setup/proposal.js';
import { EXAMPLE_MANIFEST_PATH, isFirstSetup, readScaffoldManifest } from '../../setup/scaffoldManifest.js';
import { validateJson } from '../jsonSchema.js';
import { buildEdits, splitSchemaError } from './build.js';
import type { BuildFailure, LoadText } from './build.js';
import { formatChange } from './pathDiff.js';
import { findEditTool, SETUP_EDIT_TOOL_NAMES } from './tools.js';

export const SETUP_SESSION_ENV = 'KARST_SETUP_SESSION';

export interface EditCommandDeps {
  outboxEnv?: string;
  /** `KARST_SETUP_SESSION`: present only inside a setup session. */
  sessionEnv?: string;
  /** The karst.yml of the project; absent or missing means the first setup writes the scaffold. */
  manifestPath?: string;
  readStdin?: (max: number) => string;
  readFile?: (path: string) => string;
  uuid?: () => string;
  now?: () => number;
  /** The bundled template, for the first-setup test. */
  scaffold?: () => Manifest | undefined;
  /** The template text a first setup would write; call-time checks use a placeholder id. */
  scaffoldText?: () => string | undefined;
}

export const isEditTool = (name: string | undefined): boolean => name !== undefined && SETUP_EDIT_TOOL_NAMES.includes(name);

/** The reason a setup tool is refused outside a setup session. Shared by the CLI and the MCP server. */
export function assertSetupSession(env: Readonly<Record<string, string | undefined>>, what: string): void {
  if (env[SETUP_SESSION_ENV] === undefined || env[SETUP_SESSION_ENV] === '') {
    throw new Error(`'${what}' is available only in a setup session`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readInput(tool: string, rest: readonly string[], deps: EditCommandDeps): unknown {
  let file: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== '--file') throw new Error(`karst setup ${tool}: unknown argument '${rest[i]}' (usage: karst setup ${tool} [--file <json file>], or the JSON on stdin)`);
    file = rest[(i += 1)];
    if (file === undefined) throw new Error(`karst setup ${tool}: --file needs a path`);
  }
  const raw =
    file !== undefined
      ? (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(file)
      : (deps.readStdin ?? ((max: number) => readFileSync(0, { encoding: 'utf8' }).slice(0, max)))(MAX_SETUP_PROPOSAL_BYTES);
  if (Buffer.byteLength(raw, 'utf8') > MAX_SETUP_PROPOSAL_BYTES) {
    throw new Error(`karst setup ${tool}: input is too large (max ${MAX_SETUP_PROPOSAL_BYTES} bytes)`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`karst setup ${tool}: the input is not one JSON object`);
  }
}

const rejected = (failure: Pick<BuildFailure, 'field' | 'reason' | 'opId'>): string =>
  JSON.stringify({ ok: false, ...(failure.field !== undefined ? { field: failure.field } : {}), reason: failure.reason, ...(failure.opId !== undefined ? { op: failure.opId } : {}) });

/** The tool-level input check: a schema error returns at once, before any build. */
function checkInput(tool: string, input: unknown): { field: string; reason: string } | undefined {
  const spec = findEditTool(tool)!;
  if (!isRecord(input)) return { field: '$', reason: 'the input must be one JSON object' };
  if (spec.section !== undefined) {
    // A set tool takes a sparse patch (null removes a key): the section schemas check the merged result.
    const known = Object.keys(spec.inputSchema.properties ?? {});
    const unknown = Object.keys(input).find((k) => !known.includes(k));
    if (unknown !== undefined) return { field: unknown, reason: `not a field of the ${spec.section} section (fields: ${known.join(', ')})` };
    return undefined;
  }
  const error = validateJson(spec.inputSchema, input);
  return error === null ? undefined : splitSchemaError(error);
}

function loaderFor(manifestPath: string | undefined): LoadText {
  return (text) => {
    try {
      const r = parseManifestText(text, manifestPath ?? 'karst.yml');
      return { ok: true, manifest: r.manifest, codedWarnings: r.codedWarnings };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

function templateText(deps: EditCommandDeps): string | undefined {
  if (deps.scaffoldText !== undefined) return deps.scaffoldText();
  try {
    return `id: scaffold\n\n${readFileSync(EXAMPLE_MANIFEST_PATH, 'utf8')}`;
  } catch {
    return undefined;
  }
}

/** Replays `ops` on the latest karst.yml the way the host does. */
export function previewEdits(ops: readonly EditOpFile[], deps: EditCommandDeps) {
  const load = loaderFor(deps.manifestPath);
  const baseText = deps.manifestPath !== undefined && existsSync(deps.manifestPath) ? readFileSync(deps.manifestPath, 'utf8') : undefined;
  const base = baseText !== undefined ? load(baseText) : undefined;
  const template = (deps.scaffold ?? readScaffoldManifest)();
  const firstSetup = isFirstSetup(base?.ok === true ? base.manifest : undefined, template);
  return buildEdits(baseText, ops, { firstSetup, ...(templateText(deps) !== undefined ? { scaffoldText: templateText(deps)! } : {}) }, load);
}

export function runEditTool(tool: string, rest: readonly string[], deps: EditCommandDeps): string {
  assertSetupSession({ [SETUP_SESSION_ENV]: deps.sessionEnv }, `karst setup ${tool}`);
  const outbox = resolveSetupOutboxDir(deps.outboxEnv);
  const input = readInput(tool, rest, deps);
  const bad = checkInput(tool, input);
  if (bad !== undefined) return rejected(bad);
  const pending = readEditOps(outbox);
  const probe: EditOpFile = { id: 'new', seq: '~', tool, input: input as Record<string, unknown> };
  const built = previewEdits([...pending, probe], deps);
  if (!built.ok) return rejected(built.opId === 'new' ? { ...built, opId: undefined } : built);
  const op = writeEditOp(outbox, tool, input as Record<string, unknown>, { uuid: deps.uuid, now: deps.now });
  return JSON.stringify({
    ok: true,
    id: op.id,
    edits: pending.length + 1,
    changes: built.changes.map((c) => formatChange(c)),
    ...(built.scaffolded ? { note: 'karst.yml does not exist: the host writes the scaffold first. js-yaml drops comments on a write.' } : {}),
  });
}

/** The pending edit list, for `karst setup status`. */
export function listEdits(outboxEnv: string | undefined): { id: string; tool: string; input: Record<string, unknown> }[] {
  return readEditOps(resolveSetupOutboxDir(outboxEnv)).map(({ id, tool, input }) => ({ id, tool, input }));
}

export { editsDir, withdrawEditOp };
