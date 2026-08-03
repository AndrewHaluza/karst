import type { Manifest } from '../../manifest/types.js';

/**
 * The deterministic repo classifier (§ ticket form). Signal words are authored
 * ahead of ticket time on each repository (`RepositoryDef.signals`); at ticket
 * time we score each repository by how many of its signals appear as whole-word
 * tokens in the ticket's title + description + tags. NO AI, NO network — pure
 * and testable. The ticket form seeds its repo checkboxes from this ranking;
 * the user confirms or corrects.
 *
 * Runnability is irrelevant here: classification is about which SOURCE TREE the
 * work touches, so a repository with no service is scored exactly like any
 * other. If it weren't, no ticket could ever be routed to a docs-only repo.
 */

// Re-exported so callers keep a single import site for the classify gate.
export { isRepoClassified, unclassifiedRepos } from '../../manifest/validate/graph.js';

/** Ticket text the scorer reads. */
export interface TicketText {
  title: string;
  description: string;
  tags: string[];
}

/** One repository's classifier score. */
export interface RepoScore {
  repo: string;
  score: number;
}

/** Tokenize to lowercase word tokens so matching is whole-word, not substring. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Count how many times each signal word appears as a whole token across the
 * ticket text. A multi-occurrence signal counts once per occurrence.
 */
function scoreSignals(signals: string[], tokens: string[]): number {
  if (signals.length === 0) return 0;
  const wanted = new Set(signals.map((s) => s.toLowerCase()));
  let score = 0;
  for (const tok of tokens) if (wanted.has(tok)) score += 1;
  return score;
}

/**
 * Rank every repository by signal-word hits against the ticket text. Ordered by
 * score descending, then repository name ascending, so the result is
 * deterministic (stable checkbox order + reproducible tests).
 */
export function scoreRepos(manifest: Manifest, ticket: TicketText): RepoScore[] {
  const tokens = [
    ...tokenize(ticket.title),
    ...tokenize(ticket.description),
    ...ticket.tags.flatMap((t) => tokenize(t)),
  ];
  return Object.entries(manifest.repositories)
    .map(([repo, def]) => ({ repo, score: scoreSignals(def.signals ?? [], tokens) }))
    .sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo));
}
