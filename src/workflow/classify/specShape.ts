/**
 * Decides, in code, whether a description is already a structured spec. A spec
 * keeps its own form in the improve pass (no type shape, no word cap): forcing
 * it into one sentence + sections destroyed real requirements, decisions and
 * test names (@arch:FORMEVAL). The form-eval checker imports this same rule, so
 * the prompt and its contract check cannot drift.
 */
export const SPEC_MIN_STRUCTURED_LINES = 3;

const STRUCTURED_LINE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/;

/** True when the text has at least SPEC_MIN_STRUCTURED_LINES heading or list lines. */
export function isStructuredSpec(text: string): boolean {
  return text.split('\n').filter((l) => STRUCTURED_LINE.test(l)).length >= SPEC_MIN_STRUCTURED_LINES;
}
