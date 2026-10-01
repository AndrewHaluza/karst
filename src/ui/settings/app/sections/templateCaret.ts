/**
 * Caret-scoped template transforms (NDL-126; replaces the retired vanilla
 * `variableAtCaret` / `applyTransformAtCaret` helpers, ported from
 * `git show HEAD:src/ui/settings/webview.html`).
 *
 * The rule the vanilla view stated as §8.2: a transform ONLY ever applies to a
 * real `{variable}` under the caret — it is never appended at an arbitrary
 * position, and a caret sitting on plain text refuses the transform outright.
 *
 * This module is pure: no DOM globals, no React, no events. It takes the bits
 * of a text control it needs (value, selection, a `setSelectionRange` to move
 * the caret with) and returns the new value, so the component owns the state
 * write and the caret restore. The semantics are the vanilla ones, including
 * the two odd corners:
 *
 * - a caret at the very end of the value falls back to `value.length`;
 * - an already-transformed variable (`{slug|upper}`) gets the new transform
 *   APPENDED (`{slug|upper|lower}`) — the vanilla ternary wrote `body + '|' +
 *   transform` on both branches, so a chain is extended, never replaced.
 */

/** The `{variable}` the caret sits inside: braces included in `start`/`end`. */
export interface CaretVariable {
  /** Index of the opening `{`. */
  readonly start: number;
  /** Index of the closing `}`. */
  readonly end: number;
  /** The variable name — the body up to any `|transform` chain. */
  readonly name: string;
}

/** Just enough of a text control for a caret-scoped edit. */
export interface CaretField {
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  /** Called with the post-insert caret (after the `}` of the variable + chain). */
  readonly setSelectionRange: (start: number, end: number) => void;
}

/**
 * The variable the caret sits inside, or `null`. Ported from the vanilla
 * `variableAtCaret` byte-for-byte: the last `{` at or before `caret - 1`, its
 * matching `}` not before `caret - 1`.
 */
export function variableAtCaret(value: string, caret: number): CaretVariable | null {
  const open = value.lastIndexOf('{', caret - 1);
  if (open < 0) return null;
  const close = value.indexOf('}', open);
  if (close < 0 || close < caret - 1) return null;
  const body = value.slice(open + 1, close);
  const pipe = body.indexOf('|');
  const name = pipe === -1 ? body : body.slice(0, pipe);
  return { start: open, end: close, name };
}

/**
 * Append `transform` to the variable under the caret and return the new value;
 * the value is UNCHANGED when no variable is under the caret (the vanilla
 * refusal — the caller then makes no write at all). On success the caret is
 * moved to just after the inserted chain via `setSelectionRange`.
 */
export function applyTransformAtCaret(input: CaretField, transform: string): string {
  const value = input.value;
  const pos = input.selectionStart != null ? input.selectionStart : value.length;
  const at = variableAtCaret(value, pos);
  if (!at) return value;
  const body = value.slice(at.start + 1, at.end);
  // Vanilla wrote `body.includes('|') ? body + '|' + t : body + '|' + t` —
  // both branches append, so an existing chain is extended, never replaced.
  const next = `${body}|${transform}`;
  const applied = value.slice(0, at.start + 1) + next + value.slice(at.end);
  const caret = at.start + 1 + next.length;
  input.setSelectionRange(caret, caret);
  return applied;
}
