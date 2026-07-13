import type { Manifest } from '../../manifest/types.js';
import { isServiceClassified } from '../../manifest/schema.js';

/**
 * The deterministic repo classifier (§ onboarding). Signal words are authored
 * ahead of ticket time on each service (`ServiceDef.signals`); at ticket time we
 * score each service by how many of its signals appear as whole-word tokens in
 * the ticket's title + description + tags. NO AI, NO network — pure and testable.
 * The onboarding page seeds its repo checkboxes from this ranking; the user
 * confirms or corrects.
 */

/** Ticket text the scorer reads. */
export interface TicketText {
  title: string;
  description: string;
  tags: string[];
}

/** One service's classifier score. */
export interface RepoScore {
  service: string;
  score: number;
}

/** Services that have no signal words yet — the classify-gate targets these. */
export function unclassifiedServices(manifest: Manifest): string[] {
  return Object.entries(manifest.services)
    .filter(([, svc]) => !isServiceClassified(svc))
    .map(([name]) => name);
}

/** Tokenize to lowercase word tokens so matching is whole-word, not substring. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Count how many times each signal word appears as a whole token across the
 * ticket text. A multi-occurrence signal counts once per occurrence.
 */
function scoreService(signals: string[], tokens: string[]): number {
  if (signals.length === 0) return 0;
  const wanted = new Set(signals.map((s) => s.toLowerCase()));
  let score = 0;
  for (const tok of tokens) if (wanted.has(tok)) score += 1;
  return score;
}

/**
 * Rank every service by signal-word hits against the ticket text. Ordered by
 * score descending, then service name ascending, so the result is deterministic
 * (stable checkbox order + reproducible tests).
 */
export function scoreRepos(manifest: Manifest, ticket: TicketText): RepoScore[] {
  const tokens = [
    ...tokenize(ticket.title),
    ...tokenize(ticket.description),
    ...ticket.tags.flatMap((t) => tokenize(t)),
  ];
  return Object.entries(manifest.services)
    .map(([service, svc]) => ({ service, score: scoreService(svc.signals ?? [], tokens) }))
    .sort((a, b) => b.score - a.score || a.service.localeCompare(b.service));
}
