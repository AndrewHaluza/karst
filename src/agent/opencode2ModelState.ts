import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The opencode v2 TUI's recent-model store (`<XDG_STATE_HOME>/opencode/model.json`).
 *
 * Live 2.0.27 has NO `--model` flag on the TUI (`Unrecognized flag: --model in
 * command opencode`); its first model comes from `OPENCODE_CONFIG_CONTENT.model`
 * and, when that preselection misses, from the `recent` list in this file. With
 * two providers signed in and an empty XDG state the config model was ignored
 * and the kickoff ran on the other provider's model (T1003), so a karst launch
 * writes the configured model as `recent[0]` before the spawn.
 *
 * The file shape is the TUI's own (`recent` = `{providerID, modelID}[]`,
 * `favorite` = the same, `variant` = `{ "provider/model": "<effort>" }`). Every
 * reader tolerates a malformed file, because it lives in a directory the user
 * or an older build may have written.
 */

/** Set on a sandbox launch: container path of the model-state seed file. */
export const KARST_OPENCODE2_MODEL_STATE_ENV = 'KARST_OPENCODE2_MODEL_STATE';

export interface Opencode2ModelRef {
  providerID: string;
  modelID: string;
}

export interface Opencode2ModelState {
  recent: Opencode2ModelRef[];
  favorite: Opencode2ModelRef[];
  variant: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split a karst model id (`provider/model`, optionally with `#effort`) into the
 * provider and model the TUI store records. A bare id is not an OpenCode model
 * reference and yields `null`.
 */
export function parseOpencode2ModelId(model: string): Opencode2ModelRef | null {
  const bare = model.split('#')[0] ?? model;
  const slash = bare.indexOf('/');
  if (slash <= 0 || slash === bare.length - 1) return null;
  const providerID = bare.slice(0, slash).trim();
  const modelID = bare.slice(slash + 1).trim();
  if (providerID === '' || modelID === '') return null;
  return { providerID, modelID };
}

function modelRef(value: unknown): Opencode2ModelRef | null {
  if (!isRecord(value)) return null;
  const providerID = value['providerID'];
  const modelID = value['modelID'];
  if (typeof providerID !== 'string' || providerID === '') return null;
  if (typeof modelID !== 'string' || modelID === '') return null;
  return { providerID, modelID };
}

function modelRefs(value: unknown): Opencode2ModelRef[] {
  return Array.isArray(value) ? value.flatMap((entry) => modelRef(entry) ?? []) : [];
}

function variants(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, effort]) =>
      key !== '' && typeof effort === 'string' && effort !== '' ? [[key, effort]] : [],
    ),
  );
}

/**
 * Merge the configured model into an existing store: it becomes `recent[0]`,
 * duplicates move to the front, and the list stays at the TUI's cap of 10.
 * Favourites and other models' variants survive. A launch with no effort
 * clears a stale variant for this model rather than reusing the last one.
 */
export function mergeOpencode2ModelState(
  existing: unknown,
  model: string,
  effort?: string,
): Opencode2ModelState {
  const target = parseOpencode2ModelId(model);
  if (target === null) {
    throw new Error(`opencode2 model store: '${model}' is not provider/model`);
  }
  const base = isRecord(existing) ? existing : {};
  const recent = modelRefs(base['recent']).filter(
    (entry) => entry.providerID !== target.providerID || entry.modelID !== target.modelID,
  );
  const variant = variants(base['variant']);
  const key = `${target.providerID}/${target.modelID}`;
  if (effort !== undefined && effort !== '') variant[key] = effort;
  else delete variant[key];
  return {
    recent: [{ ...target }, ...recent].slice(0, 10),
    favorite: modelRefs(base['favorite']),
    variant,
  };
}

/**
 * Ensure the store's PARENT is a real directory and refuse to write through a
 * symlink. On a docker launch this parent (`<bridge>/opencode2`) lives in the
 * sandbox-writable bridge mount, so an agent from an earlier session on the
 * same ticket can plant it as a symlink to any host directory; `mkdirSync`
 * would happily resolve it and the host would then read/write `model-state.json`
 * outside the mount. A refused parent throws — the launch treats the seed as
 * best-effort, and the TUI still gets the config model.
 */
function ensureRealDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`opencode2 model store: refusing symlinked or non-directory ${dir}`);
  }
}

function writeAtomic(file: string, body: string): void {
  // A sandbox can plant a symlink, FIFO or directory at the store path. The
  // read guard ignores them; the write must replace the entry itself, never
  // rename onto (or through) it.
  try {
    const stat = lstatSync(file);
    if (stat.isDirectory()) rmdirSync(file);
    else if (!stat.isFile()) unlinkSync(file);
  } catch {
    // ENOENT (or an entry a racing writer already removed): nothing to clear.
    // A non-empty directory still refuses the rename; the caller treats the
    // seed as best-effort rather than stalling the launch.
  }
  // `wx` never follows a planted entry at the temp path, and an unpredictable
  // name keeps the temp out of a sandbox writer's reach.
  const temporaryPath = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporaryPath, body, { flag: 'wx' });
  renameSync(temporaryPath, file);
}

/** The TUI store is a few hundred bytes; anything larger is not one of ours. */
export const MAX_MODEL_STATE_BYTES = 64 * 1024;

/**
 * Read an existing store without letting a hostile file stall the host.
 *
 * On a docker launch this path (`<bridge dir>/opencode2/model-state.json`) is
 * inside the sandbox-writable bridge mount, so a sandboxed agent could plant a
 * FIFO (a synchronous read blocks the extension host forever) or a huge file
 * (the read exhausts memory). Opening with `O_NOFOLLOW|O_NONBLOCK` and checking
 * the descriptor's type and size closes both: only a regular file within the
 * cap is parsed, and a link or pipe is ignored. The checks are on the open fd,
 * and the read itself is capped, so neither a swap between check and read nor
 * a file that keeps growing can slip through.
 */
function readExistingState(file: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MODEL_STATE_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_MODEL_STATE_BYTES + 1);
    let offset = 0;
    for (;;) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
      if (offset > MAX_MODEL_STATE_BYTES) return undefined;
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8')) as unknown;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A failed close on a read-only descriptor is not actionable here.
      }
    }
  }
}

/**
 * Write one model-state file (the TUI's `model.json`), merging an existing one.
 * Returns the path, or `null` for an id that is not a `provider/model` — never
 * writes a store the TUI cannot read. Throws only on a real I/O failure; the
 * adapter's launch path treats the seed as best-effort.
 */
export function writeOpencode2ModelState(
  file: string,
  model: string,
  effort?: string,
): string | null {
  if (parseOpencode2ModelId(model) === null) return null;
  ensureRealDir(dirname(file));
  const existing = readExistingState(file);
  writeAtomic(file, JSON.stringify(mergeOpencode2ModelState(existing, model, effort)));
  return file;
}

/**
 * Seed the TUI's store under an XDG state home (`<home>/opencode/model.json`).
 * `stateHome` must already be a karst-owned XDG dir; the caller skips a launch
 * whose isolation home is not configured.
 */
export function seedOpencode2ModelState(
  stateHome: string,
  model: string,
  effort?: string,
): string | null {
  return writeOpencode2ModelState(join(stateHome, 'opencode', 'model.json'), model, effort);
}
