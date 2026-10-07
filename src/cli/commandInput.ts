/**
 * Structured CLI input: `--file <path>` and `--stdin`.
 *
 * The registry's pain point is shell-quoting JSON into argv. Every command that
 * declares a `toArgv` encoder accepts its input as one JSON object — from a
 * file or stdin — instead of a long, quote-fragile flag list. The object is
 * validated against the command's schema (`validateCommandInput`) BEFORE the
 * encoder turns it into the argv the module's existing parser consumes, so a
 * bad payload fails once, clearly, with a non-zero exit, and a handler never
 * sees an off-shape object.
 *
 * Named flags remain the default path (no `--file`/`--stdin` present, nothing
 * here runs).
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { validateCommandInput, type CommandSpec } from './registry.js';

/** Upper bound on structured input, matching the draft-proposal cap posture. */
export const MAX_STRUCTURED_INPUT_BYTES = 1024 * 1024;

export interface StructuredInputDeps {
  /** Read stdin, at most `max + 1` bytes (the extra byte signals oversize). */
  readStdin: (max: number) => string;
  /** Injectable file reader for tests; defaults to a bounded `fs` read. */
  readFile?: (path: string) => string;
}

export interface StructuredInput {
  /** Argv (including the command name) for the existing parser. */
  argv: string[];
  /** The validated input object. */
  value: Readonly<Record<string, unknown>>;
  source: 'file' | 'stdin';
}

/** The value after `--flag`, or `undefined` when absent or flag-like. */
function flagValue(rest: readonly string[], at: number): string | undefined {
  const value = rest[at + 1];
  return value === undefined || value.startsWith('-') ? undefined : value;
}

/**
 * Read at most `max + 1` bytes from `path` and close it. Mirrors
 * `readStdinBounded`: the extra byte is enough to detect oversize, so a wrong
 * or enormous path never allocates the whole file before the size check.
 */
function readFileBounded(path: string, max: number): string {
  const fd = openSync(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(8192);
    while (total <= max) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, max + 1 - total), null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * True when the token immediately before the structured flag is another flag,
 * i.e. `--file`/`--stdin` is that flag's VALUE (`--title --file`). Structured
 * mode must not apply, so the named-flags parser sees the value as given.
 */
function isFlagValue(rest: readonly string[], at: number): boolean {
  return at > 0 && rest[at - 1]!.startsWith('--');
}

/**
 * The caller's extra tokens: everything except the command name (index 0) and
 * the structured flag (with its value for `--file`). These are checked against
 * the encoder's own tokens after the JSON is read.
 */
function extraArguments(rest: readonly string[], at: number, hasValue: boolean): string[] {
  const extras: string[] = [];
  for (let i = 1; i < rest.length; i++) {
    if (i === at) continue;
    if (hasValue && i === at + 1) continue;
    extras.push(rest[i]!);
  }
  return extras;
}

/** True when `extras` is a prefix of the encoder's own tokens. */
function isEncoderPrefix(extras: readonly string[], encoded: readonly string[]): boolean {
  return extras.length <= encoded.length && extras.every((token, i) => token === encoded[i]);
}

/**
 * Resolve structured input for `spec` from `rest`, or `undefined` when neither
 * `--file` nor `--stdin` is present (the named-flags path). Throws a clear
 * `karst <cmd>:` error on a missing/invalid payload or on a mixed invocation.
 */
export function resolveStructuredInput(
  spec: CommandSpec,
  rest: readonly string[],
  deps: StructuredInputDeps,
): StructuredInput | undefined {
  // Accept both `--file <path>` and `--file=<path>`.
  let fileAt = -1;
  let inlinePath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--file') {
      fileAt = i;
      break;
    }
    if (token.startsWith('--file=')) {
      fileAt = i;
      inlinePath = token.slice('--file='.length);
      break;
    }
  }
  const stdinAt = rest.indexOf('--stdin');
  if (fileAt === -1 && stdinAt === -1) return undefined;
  if (spec.toArgv === undefined) {
    throw new Error(`${spec.name}: --file/--stdin input is not supported for this command`);
  }
  if (fileAt !== -1 && stdinAt !== -1) {
    throw new Error(`${spec.name}: --file and --stdin are mutually exclusive`);
  }
  const at = fileAt !== -1 ? fileAt : stdinAt;
  // A flag's value that happens to be `--file`/`--stdin` is not structured input.
  if (isFlagValue(rest, at)) return undefined;
  const fileHasSeparateValue = fileAt !== -1 && inlinePath === undefined;
  const extras = extraArguments(rest, at, fileHasSeparateValue);

  let raw: string;
  let source: 'file' | 'stdin';
  if (fileAt !== -1) {
    const path = inlinePath ?? flagValue(rest, fileAt);
    if (path === undefined || path === '') throw new Error(`${spec.name}: --file needs a path`);
    const read = deps.readFile ?? ((p: string) => readFileBounded(p, MAX_STRUCTURED_INPUT_BYTES));
    try {
      raw = read(path);
    } catch (e) {
      throw new Error(`${spec.name}: cannot read --file ${path} (${(e as Error).message})`);
    }
    source = 'file';
  } else {
    raw = deps.readStdin(MAX_STRUCTURED_INPUT_BYTES);
    source = 'stdin';
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_STRUCTURED_INPUT_BYTES) {
    throw new Error(`${spec.name}: input is too large (max ${MAX_STRUCTURED_INPUT_BYTES} bytes)`);
  }
  // A UTF-8 BOM (common from Windows editors) is not part of the JSON.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${spec.name}: input is not JSON`);
  }
  const value = validateCommandInput(spec.name, parsed);
  const argv = spec.toArgv(value);
  // The caller may repeat the command's OWN leading subcommand tokens, which the
  // guide documents (`subtask create --file …`, `message send --file …`,
  // `draft propose --file …`) and the encoder supplies anyway. Anything else is
  // a contradiction against the JSON, so it is refused by name rather than
  // silently ignored.
  if (!isEncoderPrefix(extras, argv.slice(1))) {
    throw new Error(
      `${spec.name}: structured input cannot be combined with ${extras
        .map((t) => `'${t}'`)
        .join(', ')}; pass the whole input in the JSON`,
    );
  }
  return { argv, value, source };
}
