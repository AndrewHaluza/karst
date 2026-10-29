import { createHash } from 'node:crypto';

/**
 * Title shape that survives a fix round: lowercase, quoted code and line
 * references dropped, whitespace collapsed. The reviewer re-words a repeat
 * finding's line/quote freely; the rest of the title stays.
 */
export function normalizeFindingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/`[^`]*`|"[^"]*"|'[^']*'/g, ' ')
    .replace(/:\d+(?::\d+)?\b/g, '')
    .replace(/\bline\s*\d+\b|\bl\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable cross-attempt identity (`review_findings.identity`); `line` is excluded on purpose. */
export function findingIdentity(f: { repo: string; file?: string | null; title: string }): string {
  return createHash('sha1')
    .update(`${f.repo}\0${f.file ?? ''}\0${normalizeFindingTitle(f.title)}`)
    .digest('hex');
}
