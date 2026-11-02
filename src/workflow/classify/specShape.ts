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

const label = (name: string): RegExp => new RegExp(`^\\s*(?:\\*\\*)?${name}:`, 'im');
const FEATURE_LABELS: readonly RegExp[] = [label('Why'), label('Done when')];
const BUG_LABELS: readonly RegExp[] = [label('Actual'), label('Expected')];

/**
 * True when the description already carries its type's shape labels, each on
 * its own line. It comes back nearly unchanged: a rewrite prompt paraphrased
 * tight briefs and added claims (@arch:FORMEVAL).
 */
export function isAlreadyShaped(text: string, ticketType?: string): boolean {
  const labels = ticketType === 'fix' ? BUG_LABELS : FEATURE_LABELS;
  return labels.every((re) => re.test(text));
}
