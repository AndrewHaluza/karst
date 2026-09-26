/**
 * Spill oversized description/brief text to the attachment shelf at ingest.
 *
 * When a ticket's description or brief exceeds `SPILL_THRESHOLD_CHARS`, the
 * full text is written to the content-addressed attachment storage and the
 * inline field is replaced with a one-line pointer.  The original content
 * is immutable (a new attachment record) and retrievable from the shelf.
 *
 * Threshold rationale (from docs/arch/prompt-metrics.md, 443-ticket baseline):
 * - p50 description: 430 chars, p90: 2,683, 12 offenders start at 8k
 * - p90 brief: 999 chars
 * - 8,000 sits in the gap between normal content and pathological input,
 *   catching every real offender without firing on normal tickets.
 *
 * This module is vscode-free and host-agnostic — takes an injected `Store`
 * and `storageDir`.  The async `spillField` writes to the filesystem via
 * the existing `ingestBytes` + `insertAttachment` seam; the sync callers
 * in the action handlers await it before their own store writes.
 */

import type { Store } from '../store/db.js';
import type { AttachmentInput } from '../store/attachments.js';
import { insertAttachment } from '../store/attachments.js';
import { getTicket, type ProjectScope } from '../store/tickets.js';
import { ingestBytes } from './ingest.js';
import { runImmediateTransaction } from '../store/transactions.js';

/** What `spillField` did. `not-needed` and `failed` were both `null` before,
 *  which made a filesystem failure indistinguishable from a short field and
 *  left every ingest call site silently swallowing it. */
export type SpillResult =
  | { kind: 'not-needed' }
  | { kind: 'spilled'; input: AttachmentInput }
  | { kind: 'failed'; reason: string };

/**
 * The character threshold above which a description or brief is spilled to
 * the attachment shelf.  Chosen from the measured distribution, not invented.
 */
export const SPILL_THRESHOLD_CHARS = 8_000;

/**
 * Whether the given text exceeds the spill threshold and should be written
 * to the attachment shelf.  `null` / `undefined` and empty strings never
 * spill (they are valid short values).
 */
export function shouldSpill(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.length > SPILL_THRESHOLD_CHARS;
}

/**
 * Build the one-line pointer that replaces the inline field value after a
 * spill.  Names the ticket key and suggests `karst context <key>` so an
 * agent (or human) can retrieve the full content from the shelf.
 */
export function buildSpillPointer(ticketKey: string, field: 'description' | 'brief'): string {
  const label = field === 'description' ? 'description' : 'context brief';
  return (
    `[spilled to attachment shelf — ${label} exceeded ${SPILL_THRESHOLD_CHARS} chars. ` +
    `run \`karst context ${ticketKey}\` for the full state.]`
  );
}

/**
 * Write the full text to the attachment shelf and replace the inline field
 * with a pointer.  Returns a `SpillResult` discriminating "not needed" (text
 * under threshold), "spilled" (success), or "failed" (filesystem error — the
 * oversized text stays inline, non-fatal).
 *
 * The file is written with a `spilled-<field>.txt` original name so it is
 * visually distinguishable from user-picked attachments in every surface
 * that lists them.
 */
export async function spillField(
  store: Store,
  ticketId: number,
  field: 'description' | 'brief',
  text: string,
  storageDir: string,
): Promise<SpillResult> {
  if (!shouldSpill(text)) return { kind: 'not-needed' };

  const bytes = Buffer.from(text, 'utf8');
  const originalName = `spilled-${field}.txt`;

  const result = await ingestBytes(storageDir, ticketId, originalName, bytes);
  if (!result.ok) {
    // Filesystem failure is non-fatal: the oversized text stays inline
    // rather than being silently truncated.  The seed budget or the
    // tester cap will bound it at the read site — worse than a spill,
    // but not a crash.
    return { kind: 'failed', reason: result.message || 'attachment ingest failed' };
  }

  // The two database writes — inserting the attachment row and updating the
  // ticket pointer — must be atomic so a crash between them leaves no orphan
  // attachment or pointer-without-attachment.
  runImmediateTransaction(store.db, () => {
    insertAttachment(store, result.input);

    // Replace the inline field with a one-line pointer so every read site
    // (seed, tester, CLI context) sees the bounded text and knows where to
    // find the rest — without any change to the render layer.
    const ticket = getTicket(store, ticketId);
    const pointer = buildSpillPointer(ticket.key ?? String(ticketId), field);
    const column = field === 'description' ? 'description' : 'brief';
    store.db
      .prepare(`UPDATE tickets SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(pointer, ticketId);
  });

  return { kind: 'spilled', input: result.input };
}

/**
 * Backfill: spill any existing tickets whose description or brief exceeds
 * the threshold.  Idempotent — a ticket already carrying a pointer (under
 * 200 chars) is not re-spilled because `shouldSpill` returns false.
 *
 * Runs once at extension activation after migration.  Logs a warning per
 * ticket on filesystem failure rather than aborting the sweep.
 *
 * `scope` restricts the sweep to one project. It is not optional in practice:
 * a window shares the registry with every other project, and an unscoped
 * sweep would spill (and rewrite the description/brief of) other projects'
 * tickets — the store's project-scoping invariant (P2-02). Callers pass the
 * window's project; the default `{}` remains the every-project form for a
 * caller that legitimately owns the whole DB (tests, a migration-like sweep).
 */
export async function backfillSpillOversized(
  store: Store,
  storageDir: string,
  logger: { warn: (msg: string) => void },
  scope: ProjectScope = {},
): Promise<void> {
  const scoped = scope.projectId !== undefined;
  const rows = store.db
    .prepare(
      `SELECT id, key, description, brief FROM tickets
       WHERE (length(description) > ? OR length(brief) > ?)
         ${scoped ? 'AND project_id = ?' : ''}`,
    )
    .all(
      ...(scoped
        ? [SPILL_THRESHOLD_CHARS, SPILL_THRESHOLD_CHARS, scope.projectId!]
        : [SPILL_THRESHOLD_CHARS, SPILL_THRESHOLD_CHARS]),
    ) as Array<{
      id: number;
      key: string | null;
      description: string | null;
      brief: string | null;
    }>;

  for (const row of rows) {
    if (row.description && shouldSpill(row.description)) {
      const result = await spillField(
        store, row.id, 'description', row.description, storageDir,
      );
      if (result.kind === 'failed') {
        logger.warn(
          `backfill: failed to spill description for ticket ${row.key ?? row.id}: ${result.reason}`,
        );
      }
    }
    if (row.brief && shouldSpill(row.brief)) {
      const result = await spillField(
        store, row.id, 'brief', row.brief, storageDir,
      );
      if (result.kind === 'failed') {
        logger.warn(
          `backfill: failed to spill brief for ticket ${row.key ?? row.id}: ${result.reason}`,
        );
      }
    }
  }
}
