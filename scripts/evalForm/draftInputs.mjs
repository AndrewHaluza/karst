// Draft pass input: accepted planning drafts whose ticket merged. Read-only DB pull via node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import { sampleRows } from './inputs.mjs';

const REF = /\b([DT])([1-9][0-9]*)\b/g;

/** `D<n>` / `T<n>` refs cited in free text, de-duplicated, order kept. */
export function extractIdRefs(text) {
  return [...new Set([...String(text).matchAll(REF)].map((m) => m[0]))];
}

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/** One row per accepted draft with a ticket and a merged PR carrying merge_sha. Draft text stays local (gitignored output). */
export function readDraftRows(dbPath, projectSlug = null) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT pp.id AS id, pp.payload_json AS payload_json, pp.depends_on AS depends_on, pp.ticket_id AS ticket_id,
              t.key AS ticket_key, s.core AS core, s.model AS model, p.repo AS repo, p.merge_sha AS merge_sha, p.base_ref AS base_ref
         FROM planning_proposals pp
         JOIN planning_sessions s ON s.id = pp.session_id
         JOIN projects pr ON pr.id = s.project_id
         JOIN tickets t ON t.id = pp.ticket_id
         JOIN prs p ON p.ticket_id = t.id AND p.merged_at IS NOT NULL AND p.merge_sha IS NOT NULL
        WHERE pp.status = 'accepted' AND (? IS NULL OR pr.slug = ?)
        ORDER BY pp.id, p.merged_at DESC`,
    ).all(projectSlug, projectSlug);
    const seen = new Set();
    const first = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    const exists = (table, n) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(n) !== undefined;
    return first.map((r) => {
      const payload = parseJson(r.payload_json, null);
      const cited = extractIdRefs((Array.isArray(payload?.constraints) ? payload.constraints : []).join('\n'));
      const refs = Object.fromEntries(cited.map((ref) => [ref, exists(ref[0] === 'D' ? 'planning_proposals' : 'tickets', Number(ref.slice(1)))]));
      return {
        id: r.id, payload, dependsOn: parseJson(r.depends_on, []), ticketId: r.ticket_id, ticketKey: r.ticket_key,
        core: r.core, model: r.model, repo: r.repo, mergeSha: r.merge_sha, baseRef: r.base_ref, refs,
      };
    }).filter((r) => r.payload !== null);
  } finally { db.close(); }
}

export const sampleDrafts = (rows, n, seed) => sampleRows(rows, n, seed);
