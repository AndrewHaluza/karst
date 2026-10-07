/**
 * The planning proposal contract — what `karst draft propose` writes into a
 * session's outbox and what the host ingests. Pure; both sides import it, so
 * the CLI and the host apply the SAME shape, caps and control stripping.
 */

export const MAX_PROPOSAL_BYTES = 65536;
export const MAX_PROPOSAL_TITLE = 200;
export const MAX_PROPOSAL_BODY = 32 * 1024;
export const MAX_PROPOSAL_REPOS = 32;
export const PROPOSAL_REPO_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export interface Proposal {
  title: string;
  description: string;
  summary: string;
  repos: string[];
  /**
   * Optional host proposal id. Present, the proposal REVISES that existing
   * draft in place instead of creating a new one; the host authorizes the
   * update (same session, still pending) and rejects it otherwise. It is never
   * part of the stored payload — the id is the host's, not the agent's.
   */
  id?: number;
}

export type ProposalResult = { ok: true; value: Proposal } | { ok: false; reason: string };

const KEYS = ['description', 'repos', 'summary', 'title'];
const KEYS_WITH_ID = [...KEYS, 'id'].sort() as string[];
// C0 (minus \t \n), DEL, C1, and bidi embedding/override/isolate/mark controls.
const BODY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;
const ALL_CONTROLS = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

const fail = (reason: string): ProposalResult => ({ ok: false, reason });

function body(raw: Record<string, unknown>, key: 'description' | 'summary'): string | undefined {
  const v = raw[key];
  if (typeof v !== 'string' || v.length > MAX_PROPOSAL_BODY) return undefined;
  return v.replace(BODY_CONTROLS, '');
}

export function validateProposal(raw: unknown): ProposalResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('proposal must be a JSON object');
  const rec = raw as Record<string, unknown>;
  const keys = Object.keys(rec).sort().join(',');
  if (keys !== KEYS.join(',') && keys !== KEYS_WITH_ID.join(',')) {
    return fail(`proposal keys must be exactly ${KEYS.join(', ')} (plus an optional id)`);
  }

  let id: number | undefined;
  if ('id' in rec) {
    const v = rec.id;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      return fail('id must be a positive integer');
    }
    id = v;
  }

  const t = rec.title;
  if (typeof t !== 'string' || /[\r\n]/.test(t)) return fail('title must be a single-line string');
  const title = t.replace(ALL_CONTROLS, '').trim();
  if (title === '' || title.length > MAX_PROPOSAL_TITLE) return fail(`title must be 1-${MAX_PROPOSAL_TITLE} characters`);

  const description = body(rec, 'description');
  if (description === undefined) return fail(`description must be a string of at most ${MAX_PROPOSAL_BODY} characters`);
  const summary = body(rec, 'summary');
  if (summary === undefined) return fail(`summary must be a string of at most ${MAX_PROPOSAL_BODY} characters`);

  const repos = rec.repos;
  if (!Array.isArray(repos) || repos.length > MAX_PROPOSAL_REPOS) return fail(`repos must be an array of at most ${MAX_PROPOSAL_REPOS} names`);
  if (!repos.every((r): r is string => typeof r === 'string' && PROPOSAL_REPO_NAME.test(r))) {
    return fail('every repo must be a name matching [A-Za-z0-9._-]{1,64}');
  }
  const value: Proposal = { title, description, summary, repos: [...repos] };
  if (id !== undefined) value.id = id;
  return { ok: true, value };
}
