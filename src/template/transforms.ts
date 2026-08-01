/**
 * The transform registry every template surface shares.
 *
 * A placeholder may pipe its value through transforms — `{key|slice:-4}` — and
 * the point of the whole mechanism is reclaiming horizontal space: ticket ids
 * from an external tracker share long prefixes (`869e82530`, `869e820e2`), so
 * rendering them whole repeats characters that distinguish nothing.
 *
 * Two rules shape what lives here:
 *
 * 1. **Validate at configuration time, apply at render time.** Every argument is
 *    checked when the manifest loads, naming the offending placeholder. Nothing
 *    is coerced later: a `slice:abc` that quietly became `slice:0` is exactly the
 *    silent-at-render failure this split exists to prevent. `applyTransforms`
 *    therefore assumes validated specs and NEVER throws on runtime data —
 *    null, undefined and non-strings all have defined behavior.
 * 2. **No two transforms overlap.** `slice` is the exact cut with JS semantics;
 *    `truncate` is the readable one (conditional, marked). `kebab`/`snake`
 *    destroy interior whitespace, `trim` preserves it. Padding is deliberately
 *    absent — it makes names WIDER, and the surfaces these templates feed are
 *    proportional-font (tree labels, terminal tabs) or charset-restricted (git
 *    refs), so padded columns would not align and the padding would be sanitized
 *    away.
 *
 * Transforms are pure: they read the coerced value and return a new string.
 */

import type { TemplateToken, TransformSpec } from './token.js';

/** A validated transform: how many arguments it takes and what it does. */
interface TransformDefinition {
  /** Maximum arguments; the argument text is split on the first `max - 1` commas. */
  readonly maxArgs: number;
  /** Reject the split arguments, returning the reason (without the field prefix). */
  validate(args: readonly string[], argText: string | undefined): string | undefined;
  apply(value: string, args: readonly string[]): string;
}

const INTEGER = /^-?\d+$/;
const POSITIVE_INTEGER = /^\d+$/;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;
const DEFAULT_TRUNCATE_MARKER = '…';

/** Reject any argument list for a transform that takes none. */
function takesNoArguments(name: string) {
  return (_args: readonly string[], argText: string | undefined): string | undefined =>
    argText === undefined ? undefined : `${name} takes no arguments`;
}

const TRANSFORMS: Record<string, TransformDefinition> = {
  /**
   * Exactly `String.prototype.slice`, including negative indices, out-of-range
   * indices and `start >= end` (empty). Operates on UTF-16 CODE UNITS, so an
   * index can land between the halves of an astral character — that is JS's
   * behavior and the price of the "matches slice exactly" contract.
   */
  slice: {
    maxArgs: 2,
    validate(args, argText) {
      if (argText === undefined) {
        return 'slice requires a start index, e.g. {key|slice:-4}';
      }
      if (!INTEGER.test(args[0] ?? '')) return 'start must be an integer';
      if (args.length > 1 && !INTEGER.test(args[1]!)) return 'end must be an integer';
      return undefined;
    },
    apply(value, args) {
      const start = Number.parseInt(args[0]!, 10);
      return args.length > 1 ? value.slice(start, Number.parseInt(args[1]!, 10)) : value.slice(start);
    },
  },

  /**
   * Shorten to at most `width` characters ONLY when longer, marking the cut. The
   * marker is inside the budget, so the result never exceeds `width`. Counts
   * CODE POINTS (unlike `slice`) because its job is readable output and half a
   * surrogate pair is not readable.
   */
  truncate: {
    maxArgs: 2,
    validate(args, argText) {
      if (argText === undefined) {
        return 'truncate requires a width, e.g. {title|truncate:20}';
      }
      const width = args[0] ?? '';
      if (!POSITIVE_INTEGER.test(width) || Number.parseInt(width, 10) < 1) {
        return 'width must be a positive integer';
      }
      return undefined;
    },
    apply(value, args) {
      const width = Number.parseInt(args[0]!, 10);
      const marker = args.length > 1 ? args[1]! : DEFAULT_TRUNCATE_MARKER;
      const points = [...value];
      if (points.length <= width) return value;
      const markerPoints = [...marker];
      // A marker at least as wide as the budget leaves no room for content, so
      // fall back to a hard cut rather than emitting marker-only output.
      if (markerPoints.length >= width) return points.slice(0, width).join('');
      return points.slice(0, width - markerPoints.length).join('') + marker;
    },
  },

  upper: {
    maxArgs: 0,
    validate: takesNoArguments('upper'),
    apply: (value) => value.toUpperCase(),
  },

  lower: {
    maxArgs: 0,
    validate: takesNoArguments('lower'),
    apply: (value) => value.toLowerCase(),
  },

  /** Lowercase, every non-alphanumeric run collapsed to one `-`, edges stripped. */
  kebab: {
    maxArgs: 0,
    validate: takesNoArguments('kebab'),
    apply: (value) => separate(value, '-'),
  },

  /** Lowercase, every non-alphanumeric run collapsed to one `_`, edges stripped. */
  snake: {
    maxArgs: 0,
    validate: takesNoArguments('snake'),
    apply: (value) => separate(value, '_'),
  },

  /** `String.prototype.trim` — edges only; the interior survives intact. */
  trim: {
    maxArgs: 0,
    validate: takesNoArguments('trim'),
    apply: (value) => value.trim(),
  },

  /**
   * Replace an EMPTY value (missing field, null, or `''`). Whitespace-only is
   * not empty — write `{status|trim|default:none}` when it should be.
   */
  default: {
    maxArgs: 1,
    validate(args) {
      return (args[0] ?? '') === '' ? 'default requires a replacement value' : undefined;
    },
    apply: (value, args) => (value === '' ? args[0]! : value),
  },
};

/** Every supported transform name, in documentation order. */
export const TRANSFORM_NAMES = Object.keys(TRANSFORMS) as readonly string[];

/**
 * Lowercase + one separator per non-alphanumeric run. Unicode-aware (`\p{L}`,
 * `\p{N}`), so a non-Latin title keeps its letters instead of collapsing away.
 */
function separate(value: string, separator: string): string {
  const edges = new RegExp(`^\\${separator}+|\\${separator}+$`, 'g');
  return value.toLowerCase().replace(NON_ALPHANUMERIC, separator).replace(edges, '');
}

/**
 * Split argument text for a transform of the given arity: on the first
 * `maxArgs - 1` commas, so the LAST argument keeps any commas it contains
 * (`{title|truncate:20, …}`) and a one-argument transform takes its text whole.
 */
function splitArgs(argText: string, maxArgs: number): string[] {
  if (maxArgs <= 1) return [argText];
  const comma = argText.indexOf(',');
  if (comma === -1) return [argText];
  return [argText.slice(0, comma), ...splitArgs(argText.slice(comma + 1), maxArgs - 1)];
}

/**
 * Coerce one runtime value to the string a transform chain operates on. Render
 * must never throw on data, so null/undefined become `''` and even a value whose
 * `toString` throws degrades to `''` rather than taking down the surface.
 */
export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '';
  }
}

/**
 * Validate one template's transform chains. Variables are NOT checked here —
 * each renderer owns its own vocabulary and its own idea of what an unknown one
 * means — so this is safe to call from the lenient label surface too.
 *
 * Throws naming `field`, the offending placeholder, and the reason.
 */
export function validateTemplateTransforms(
  field: string,
  tokens: readonly TemplateToken[],
): void {
  for (const token of tokens) {
    for (const spec of token.transforms) {
      if (spec.name === '') {
        throw new Error(`${field} contains an empty transform name in "${token.raw}"`);
      }
      const definition = TRANSFORMS[spec.name];
      if (!definition) {
        throw new Error(
          `${field} contains unknown transform "${spec.name}" in "${token.raw}" ` +
            `(supported: ${TRANSFORM_NAMES.join(', ')})`,
        );
      }
      const reason = definition.validate(argsFor(definition, spec), spec.argText);
      if (reason) {
        throw new Error(
          `${field} has an invalid "${spec.name}" argument in "${token.raw}": ${reason}`,
        );
      }
    }
  }
}

/** The split arguments a spec carries, or none when it wrote no `:`. */
function argsFor(definition: TransformDefinition, spec: TransformSpec): string[] {
  if (spec.argText === undefined) return [];
  return splitArgs(spec.argText, definition.maxArgs);
}

/**
 * Apply a VALIDATED chain left to right. Unvalidated or unknown transforms are
 * skipped rather than thrown on: this runs on every label repaint, and a
 * configuration mistake must already have been reported at load time.
 */
export function applyTransforms(
  value: unknown,
  transforms: readonly TransformSpec[],
): string {
  let current = renderValue(value);
  for (const spec of transforms) {
    const definition = TRANSFORMS[spec.name];
    if (!definition) continue;
    current = definition.apply(current, argsFor(definition, spec));
  }
  return current;
}
