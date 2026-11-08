import { forbiddenBodyChar } from './messageText.js';

/**
 * Arch citations (@arch:CLI-22): the per-ticket record that says "this diff
 * touches a symbol an @arch block covers, and the block still holds, because …".
 * An agent writes one through `karst arch cite`; Karst renders the record as the
 * PR body the docs gate reads (`PR_BODY`) and as the `## Design rules checked`
 * section of the shipped PR body. Pure text rules only — no store, no I/O.
 *
 * The reason is UNTRUSTED agent prose. It is bounded, refused when it carries a
 * control character, and escaped when rendered, so it can neither open a new
 * markdown structure, ping a GitHub user, nor forge a second `@arch:` citation.
 */

/** Longest reason `arch cite` accepts, in characters. */
export const CITE_REASON_MAX = 200;
/** Longest key `arch cite` accepts, in characters. */
export const CITE_KEY_MAX = 80;
/** Heading of the section Karst appends to every PR body. */
export const DESIGN_RULES_HEADING = '## Design rules checked';

/** A key as written in a block header, e.g. UATHOST-00 with the arch prefix. */
const KEY_PATTERN = /^@([a-z][a-z0-9]*:[A-Za-z0-9][A-Za-z0-9_.-]*)$/;

export interface ArchCitation {
  /** Canonical key with its leading `@`, e.g. `@arch:UATHOST-00`. */
  readonly key: string;
  /** One bounded line of plain text. */
  readonly reason: string;
}

/** Canonical key with its leading `@` for user input (the `@` is optional); throws on a malformed key. */
export function normalizeArchKey(raw: string): string {
  const trimmed = raw.trim();
  const withAt = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  if (withAt.length > CITE_KEY_MAX || !KEY_PATTERN.test(withAt)) {
    throw new Error(`'${raw.slice(0, CITE_KEY_MAX)}' is not an arch key (want the arch prefix and a block ID, as in @arch:UATHOST-00)`);
  }
  return withAt;
}

/** Validate a reason: one non-empty line, no control characters, at most CITE_REASON_MAX characters. */
export function normalizeCitationReason(raw: string): string {
  const reason = raw.trim().replace(/\s+/gu, ' ');
  if (reason === '') throw new Error('--why needs a reason: say why the block still holds');
  const bad = forbiddenBodyChar(raw.replace(/\s/gu, ' '));
  if (bad !== null) throw new Error(`--why holds a control character (${bad})`);
  if ([...reason].length > CITE_REASON_MAX) {
    throw new Error(`--why is too long (max ${CITE_REASON_MAX} characters)`);
  }
  return reason;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '@': '&#64;',
  '#': '&#35;',
  '\\': '\\\\',
  '`': '\\`',
  '*': '\\*',
  _: '\\_',
  '[': '\\[',
  ']': '\\]',
  '|': '\\|',
};

/** Escape a reason for markdown. `@` becomes an entity, so the reason can never cite a key or mention a user. */
export function escapeCitationReason(reason: string): string {
  return reason.replace(/[&<>@#\\`*_[\]|]/gu, (ch) => ESCAPES[ch] ?? ch);
}

/** One citation line: `@arch:KEY — <escaped reason>`. */
export function renderCitationLine(c: ArchCitation): string {
  return `${c.key} — ${escapeCitationReason(c.reason)}`;
}

/** The lines Karst hands the docs gate as its PR body; empty when nothing was cited. */
export function renderCitationText(citations: readonly ArchCitation[]): string {
  return sortCitations(citations).map(renderCitationLine).join('\n');
}

function sortCitations(citations: readonly ArchCitation[]): ArchCitation[] {
  return [...citations].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The `## Design rules checked` section (no trailing newline); empty when nothing was cited. */
export function renderDesignRulesSection(citations: readonly ArchCitation[]): string {
  if (citations.length === 0) return '';
  return `${DESIGN_RULES_HEADING}\n\n${sortCitations(citations).map((c) => `- ${renderCitationLine(c)}`).join('\n')}`;
}

/** Index of the section heading at the start of a line, or -1. */
function sectionStart(body: string): number {
  const m = new RegExp(`^${DESIGN_RULES_HEADING}[ \\t]*$`, 'mu').exec(body);
  return m === null ? -1 : m.index;
}

/** End of the section that starts at `start`: the next level-1/2 heading, or the end of the body. */
function sectionEnd(body: string, start: number): number {
  const rest = body.slice(start + DESIGN_RULES_HEADING.length);
  const next = /^#{1,2} /mu.exec(rest);
  return next === null ? body.length : start + DESIGN_RULES_HEADING.length + next.index;
}

/**
 * Put the section at the END of a freshly built body, after any sanitizing. A
 * section the body already carries is replaced, never doubled. No citations:
 * the body is returned unchanged.
 */
export function appendDesignRulesSection(body: string, citations: readonly ArchCitation[]): string {
  return upsertDesignRulesSection(body, citations);
}

/**
 * Bring the section of an EXISTING body in line with the citations: replace the
 * Karst section in place (human prose around it is kept) or append one. Returns
 * the body unchanged when there is nothing to cite.
 */
export function upsertDesignRulesSection(body: string, citations: readonly ArchCitation[]): string {
  const section = renderDesignRulesSection(citations);
  if (section === '') return body;
  const start = sectionStart(body);
  if (start === -1) {
    const trimmed = body.replace(/\s+$/u, '');
    return trimmed === '' ? `${section}\n` : `${trimmed}\n\n${section}\n`;
  }
  const end = sectionEnd(body, start);
  const before = body.slice(0, start);
  const after = body.slice(end).replace(/^\s+/u, '');
  return `${before}${section}\n${after === '' ? '' : `\n${after}`}`;
}
