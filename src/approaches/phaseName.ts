/**
 * The one definition of what a workflow phase name may contain.
 *
 * A phase name is a shell token, not free text: it is interpolated into the
 * `karst … phase <name>` marker command line the agent executes, and
 * approach.yml is fetched from an untrusted source. It is therefore validated
 * TWICE — once at install (`requireWorkflow`, `pkg.ts`) so a hostile approach
 * fails loudly rather than materializing a weaponized command, and again at the
 * CLI on receipt, because argv arrives from an agent that read ticket content it
 * did not author and is not trusted just because install-time validation exists.
 *
 * Both checks live here so there is exactly one charset and one wording. A
 * second copy of the regex would drift, and the drift would be silent.
 */

/**
 * An alphanumeric word with internal `_`/`-`, bounded at 64 characters — every
 * real phase name (`describe`, `research`, `plan`, `implement`) fits, while
 * quotes, whitespace, redirects and command separators cannot appear at all.
 */
export const PHASE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Whether `name` could be safely interpolated into a command line. */
export function isSafePhaseName(name: string): boolean {
  return PHASE_NAME_RE.test(name);
}

/**
 * The single wording for a rejected phase name. Callers wrap it in whichever
 * error type suits their boundary (`ManifestError` at install, a plain `Error`
 * at the CLI, where "Invalid karst.yml" would name the wrong culprit).
 */
export function phaseNameFault(where: string, name: string): string {
  return (
    `${where} is interpolated into a shell command the agent runs, so it must be ` +
    `1-64 characters of letters, digits, "_" or "-", starting with a letter or ` +
    `digit: "${name}"`
  );
}
