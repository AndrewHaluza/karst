/**
 * Shared argv parsing for the `karst test` subcommands.
 *
 * Every subcommand takes the same shape — `--key value` pairs, with a small
 * closed set of boolean flags (`--json`) that carry no value. This is the ONE
 * flag parser the driver uses, so a malformed line fails in the same words on
 * every subcommand and no subcommand re-implements the loop.
 */

/** Boolean flags that appear without a value (accepted, recorded as 'true'). */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['json']);

export type TestFlags = Record<string, string | undefined>;

/**
 * Parse `--key value` pairs from a subcommand's argv (the argv already had the
 * subcommand token removed). Rejects positional tokens and value-less flags,
 * so a mistyped `--stage` (with no value) fails loudly instead of reading the
 * NEXT flag's name as its value.
 */
export function parseFlags(argv: string[]): TestFlags {
  const flags: TestFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) {
      throw new Error(`unexpected argument '${arg ?? ''}' (want --<flag> <value>)`);
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = 'true';
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`flag '--${name}' requires a value`);
    }
    flags[name] = value;
    i++;
  }
  return flags;
}

/** Require a flag to be present and non-empty; name it in the error. */
export function requireFlag(flags: TestFlags, name: string): string {
  const value = flags[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required flag '--${name}'`);
  }
  return value;
}

/** Parse a flag as a non-negative integer, naming the flag in the error. */
export function requireIntFlag(flags: TestFlags, name: string): number {
  const raw = requireFlag(flags, name);
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`flag '--${name}' must be an integer (got '${raw}')`);
  }
  return parseInt(raw, 10);
}
