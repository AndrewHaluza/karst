import type { Store } from './db.js';
import type { StallSuggestion } from '../model/stallSuggestion.js';

/** The DDL schema.sql mirrors for a fresh DB (the v102 migration step execs it). */
export const STALL_SUGGESTIONS_DDL = `
CREATE TABLE IF NOT EXISTS review_stall_suggestions (
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  park_at      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  suggestion   TEXT,
  error        TEXT,
  usage_limit  INTEGER NOT NULL DEFAULT 0,
  diff         TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (ticket_id, park_at)
);
`;

/** A `generating` row older than this is a dead host's claim and may be taken over. */
export const STALL_GENERATING_STALE_MS = 15 * 60_000;

export type StallSuggestionRow =
  | { status: 'generating'; updatedAt: string }
  | { status: 'ready'; suggestion: StallSuggestion; updatedAt: string }
  | { status: 'failed'; error: string; usageLimit: boolean; updatedAt: string };

interface Raw {
  status: string;
  suggestion: string | null;
  error: string | null;
  usage_limit: number;
  updated_at: string;
}

/** The park's suggestion row, or null when none was started. */
export function getStallSuggestion(store: Store, ticketId: number, parkAt: string): StallSuggestionRow | null {
  const r = store.db
    .prepare('SELECT status, suggestion, error, usage_limit, updated_at FROM review_stall_suggestions WHERE ticket_id = ? AND park_at = ?')
    .get(ticketId, parkAt) as Raw | undefined;
  if (r === undefined) return null;
  if (r.status === 'ready' && r.suggestion !== null) {
    try {
      return { status: 'ready', suggestion: JSON.parse(r.suggestion) as StallSuggestion, updatedAt: r.updated_at };
    } catch {
      return { status: 'failed', error: 'the stored suggestion is unreadable', usageLimit: false, updatedAt: r.updated_at };
    }
  }
  if (r.status === 'failed') {
    return { status: 'failed', error: r.error ?? 'the suggestion failed', usageLimit: r.usage_limit === 1, updatedAt: r.updated_at };
  }
  return { status: 'generating', updatedAt: r.updated_at };
}

/**
 * Take the right to generate for this park. True = the caller generates now.
 * False = a live generation or a ready answer exists. A failed row (Retry) and a
 * stale `generating` row are taken over. One statement, so two windows cannot both win.
 */
export function claimStallSuggestion(store: Store, ticketId: number, parkAt: string, now: string, retry = false): boolean {
  const staleBefore = new Date(Date.parse(now) - STALL_GENERATING_STALE_MS).toISOString();
  const inserted = store.db
    .prepare(
      `INSERT INTO review_stall_suggestions (ticket_id, park_at, status, updated_at) VALUES (?, ?, 'generating', ?)
       ON CONFLICT (ticket_id, park_at) DO UPDATE SET status = 'generating', suggestion = NULL, error = NULL, usage_limit = 0, updated_at = excluded.updated_at
         WHERE (status = 'failed' AND ? = 1) OR (status = 'generating' AND updated_at < ?)`,
    )
    .run(ticketId, parkAt, now, retry ? 1 : 0, staleBefore);
  return inserted.changes > 0;
}

export function saveStallSuggestion(store: Store, ticketId: number, parkAt: string, suggestion: StallSuggestion, now: string): void {
  store.db
    .prepare("UPDATE review_stall_suggestions SET status = 'ready', suggestion = ?, error = NULL, usage_limit = 0, updated_at = ? WHERE ticket_id = ? AND park_at = ?")
    .run(JSON.stringify(suggestion), now, ticketId, parkAt);
}

export function failStallSuggestion(store: Store, ticketId: number, parkAt: string, error: string, usageLimit: boolean, now: string): void {
  store.db
    .prepare("UPDATE review_stall_suggestions SET status = 'failed', suggestion = NULL, error = ?, usage_limit = ?, updated_at = ? WHERE ticket_id = ? AND park_at = ?")
    .run(error, usageLimit ? 1 : 0, now, ticketId, parkAt);
}

/** The diff a suggestion was written against: the changed files and the stat text. */
export interface StoredStallDiff {
  files: string[];
  stat: string;
}

export function saveStallDiff(store: Store, ticketId: number, parkAt: string, diff: StoredStallDiff): void {
  store.db
    .prepare('UPDATE review_stall_suggestions SET diff = ? WHERE ticket_id = ? AND park_at = ?')
    .run(JSON.stringify(diff), ticketId, parkAt);
}

/** The stored diff of the park, or null when none was saved or it is unreadable. */
export function getStallDiff(store: Store, ticketId: number, parkAt: string): StoredStallDiff | null {
  const r = store.db
    .prepare('SELECT diff FROM review_stall_suggestions WHERE ticket_id = ? AND park_at = ?')
    .get(ticketId, parkAt) as { diff: string | null } | undefined;
  if (r?.diff == null) return null;
  try {
    const v = JSON.parse(r.diff) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const { files, stat } = v as { files?: unknown; stat?: unknown };
    if (!Array.isArray(files) || !files.every((x) => typeof x === 'string') || typeof stat !== 'string') return null;
    return { files: files as string[], stat };
  } catch {
    return null;
  }
}
