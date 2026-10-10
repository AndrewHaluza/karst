/**
 * Carrying a draft's `constraints` into the ticket brief. Pure. The heading is
 * the idempotency marker: a brief that already has it is returned unchanged.
 */

export const CONSTRAINTS_HEADING = '## Design constraints';

export function appendConstraintsToBrief(brief: string, constraints: readonly string[]): string {
  if (constraints.length === 0) return brief;
  if (brief.split('\n').some((l) => l.trim() === CONSTRAINTS_HEADING)) return brief;
  const block = [CONSTRAINTS_HEADING, ...constraints.map((c) => `- ${c}`)].join('\n');
  return brief.trim() === '' ? block : `${brief.replace(/\s+$/, '')}\n\n${block}`;
}
