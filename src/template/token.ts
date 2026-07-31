/**
 * Placeholder grammar shared by every Karst template surface.
 *
 * A placeholder is `{variable}` optionally followed by a left-to-right pipe
 * chain of transforms: `{key|slice:-4|upper}`. Parsing is deliberately split
 * from the transform registry — the three renderers (ticket label, git
 * artifacts, branch name) disagree about which VARIABLES exist and about what a
 * bad one means, but they must agree byte-for-byte about how a placeholder is
 * cut into `variable` + transforms, or the same template would mean two things.
 *
 * Parsing NEVER throws: an empty variable, an empty transform name and an empty
 * argument list all parse into a representable shape so the caller can raise the
 * error naming the offending placeholder. Arguments are kept VERBATIM (splitting
 * them depends on the transform's arity, which lives in the registry).
 */

/** One `name[:args]` element of a placeholder's pipe chain, unvalidated. */
export interface TransformSpec {
  readonly name: string;
  /** Raw text after the first `:`, or undefined when no `:` was written. */
  readonly argText: string | undefined;
}

/** A placeholder body cut into its variable and its ordered transform chain. */
export interface TokenBody {
  readonly variable: string;
  readonly transforms: readonly TransformSpec[];
}

/** A placeholder located in a template, with the source text for error messages. */
export interface TemplateToken extends TokenBody {
  /** Full placeholder text including braces, e.g. `"{key|slice:-4}"`. */
  readonly raw: string;
  /** Offset of the opening brace in the template. */
  readonly index: number;
}

/**
 * Matches one placeholder. Nested braces are not part of the grammar, so a stray
 * brace survives into the remainder and each renderer's own "malformed braces"
 * guard reports it.
 */
export const TOKEN_PATTERN = /\{([^{}]*)\}/g;

/** Cut one placeholder body (the text between the braces) into its parts. */
export function parseTokenBody(body: string): TokenBody {
  const [head = '', ...rest] = body.split('|');
  return {
    variable: head.trim(),
    transforms: rest.map(parseTransformSpec),
  };
}

/** Cut one `name[:args]` chain element; the name is trimmed, args are not. */
function parseTransformSpec(raw: string): TransformSpec {
  const colon = raw.indexOf(':');
  if (colon === -1) return { name: raw.trim(), argText: undefined };
  return { name: raw.slice(0, colon).trim(), argText: raw.slice(colon + 1) };
}

/** Every placeholder in `template`, in source order. */
export function parseTemplateTokens(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    tokens.push({
      raw: match[0],
      index: match.index!,
      ...parseTokenBody(match[1]!),
    });
  }
  return tokens;
}

/**
 * Whether `template` interpolates `variable`. Transform-aware on purpose:
 * `{description|trim}` still needs the generated summary, and a plain
 * `includes('{description}')` would silently decide it does not.
 */
export function hasVariable(template: string, variable: string): boolean {
  return parseTemplateTokens(template).some((token) => token.variable === variable);
}
