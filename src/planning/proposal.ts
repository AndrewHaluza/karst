/**
 * The planning proposal contract — what `karst draft propose` writes into a
 * session's outbox and what the host ingests. Pure; both sides import it, so
 * the CLI and the host apply the SAME shape, caps and control stripping.
 */

export const MAX_PROPOSAL_BYTES = 65536;
export const MAX_PROPOSAL_TITLE = 200;
export const MAX_PROPOSAL_BODY = 32 * 1024;
export const MAX_PROPOSAL_REPOS = 32;
export const MAX_PROPOSAL_DEPENDS_ON = 32;
export const MAX_PROPOSAL_CONSTRAINTS = 20;
export const MAX_CONSTRAINT_LEN = 200;
export const MAX_PRIORITY_REASON = 200;
export { PRIORITY_LEVELS, asPriorityLevel, type PriorityLevel } from '../model/priority.js';
/** Code whose content shapes agent prompts; a draft touching it should cite a design rule. */
export const PROMPT_SENSITIVE_PATHS: readonly string[] = [
  'src/agent/seed.ts',
  'src/agent/entrySeed.ts',
  'src/agent/instructions.ts',
  'src/context/ticketContext.ts',
  'src/planning/preamble.ts',
];
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
  /**
   * Optional entries this draft waits on: a host proposal id (`3` or `D3`, a
   * draft of ANY session of the project, as `karst queue` lists) or a `T<n>`
   * open ticket. Drafts are resolved to ticket links when the target is
   * accepted and pruned if it is discarded; a ticket becomes a `blocked-by`
   * row on accept. Normalized here to a number (draft) or a `T<n>` string
   * (ticket) and deduped; the host additionally rejects unknown ids, other
   * projects' ids, closed tickets and cycles.
   */
  dependsOn?: (number | `T${number}`)[];
  /**
   * Optional design rules and prior work the draft builds on: `@arch:KEY`,
   * a commit hash, a `D<n>`/`T<n>`/`#N` ref (draft/ticket/PR) or free text. Trimmed, deduped,
   * order kept. Absent reads as none.
   */
  constraints?: string[];
  /** Optional proposed priority of the draft; the user may override it in the sidebar. */
  priority?: PriorityLevel;
  /** One-line reason for `priority` (at most 200 chars). Needs `priority`. */
  priorityReason?: string;
  /** Optional evidence files the host copies at propose time; Review stages them for the ticket. */
  attachments?: ProposalAttachment[];
}

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_PATH = 300;
export const MAX_ATTACHMENT_NOTE = 200;
/** One evidence file a draft names: `path` is relative to the session's artifacts dir. */
export interface ProposalAttachment {
  path: string;
  note?: string;
  binding?: boolean;
}

export type ProposalResult = { ok: true; value: Proposal } | { ok: false; reason: string };

import { PRIORITY_LEVELS, asPriorityLevel, type PriorityLevel } from '../model/priority.js';
import { parseId } from '../model/entityId.js';

const REQUIRED_KEYS = ['description', 'repos', 'summary', 'title'];
const OPTIONAL_KEYS = ['id', 'dependsOn', 'constraints', 'priority', 'priorityReason', 'attachments'];
const ALLOWED_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
// C0 (minus \t \n), DEL, C1, and bidi embedding/override/isolate/mark controls.
const BODY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;
const ALL_CONTROLS = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

/** A draft id as a number: `3`, `"3"`, `"D3"` or `"d3"`; anything else (incl. other prefixes) is undefined. */
function asDraftNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  try {
    return parseId(v, 'draft').n;
  } catch {
    return undefined;
  }
}

/** A dependsOn entry as a draft number or a `T<n>` ticket string; anything else is undefined. */
function asDependency(v: unknown): number | `T${number}` | undefined {
  const draft = asDraftNumber(v);
  if (draft !== undefined) return draft;
  if (typeof v !== 'string') return undefined;
  try {
    return `T${parseId(v, 'ticket').n}`;
  } catch {
    return undefined;
  }
}

function validateAttachments(v: unknown): { ok: true; value: ProposalAttachment[] } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!Array.isArray(v)) return bad('attachments must be an array');
  if (v.length > MAX_ATTACHMENTS) return bad(`attachments must have at most ${MAX_ATTACHMENTS} entries`);
  const value: ProposalAttachment[] = [];
  for (const e of v as unknown[]) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return bad('attachments entries must be objects');
    const r = e as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      if (k !== 'path' && k !== 'note' && k !== 'binding') return bad(`unknown attachment key "${k}"`);
    }
    const p = r.path;
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_ATTACHMENT_PATH) {
      return bad(`attachment path must be 1-${MAX_ATTACHMENT_PATH} characters`);
    }
    if (p.startsWith('/') || p.split(/[\\/]/).includes('..')) return bad('attachment path must be relative with no ".." segment');
    const out: ProposalAttachment = { path: p.replace(ALL_CONTROLS, '') };
    if (r.note !== undefined) {
      if (typeof r.note !== 'string' || /[\r\n]/.test(r.note)) return bad('attachment note must be a single-line string');
      const note = r.note.replace(ALL_CONTROLS, '');
      if (note.length > MAX_ATTACHMENT_NOTE) return bad(`attachment note must be at most ${MAX_ATTACHMENT_NOTE} characters`);
      out.note = note;
    }
    if (r.binding !== undefined) {
      if (typeof r.binding !== 'boolean') return bad('attachment binding must be a boolean');
      out.binding = r.binding;
    }
    value.push(out);
  }
  return { ok: true, value };
}

const fail = (reason: string): ProposalResult => ({ ok: false, reason });

function body(raw: Record<string, unknown>, key: 'description' | 'summary'): string | undefined {
  const v = raw[key];
  if (typeof v !== 'string' || v.length > MAX_PROPOSAL_BODY) return undefined;
  return v.replace(BODY_CONTROLS, '');
}

export function validateProposal(raw: unknown): ProposalResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('proposal must be a JSON object');
  const rec = raw as Record<string, unknown>;
  if ('hostWarnings' in rec) return fail('hostWarnings is host-owned and may not be supplied');
  if ('hostAttachments' in rec) return fail('hostAttachments is host-owned and may not be supplied');
  for (const k of Object.keys(rec)) {
    if (!ALLOWED_KEYS.includes(k)) {
      return fail(`unknown key "${k}"; allowed keys are ${ALLOWED_KEYS.join(', ')}`);
    }
  }
  for (const k of REQUIRED_KEYS) {
    if (!(k in rec)) return fail(`missing required key "${k}"`);
  }

  let id: number | undefined;
  if ('id' in rec) {
    id = asDraftNumber(rec.id);
    if (id === undefined) return fail('id must be a positive integer or a D<n> id');
  }

  let dependsOn: (number | `T${number}`)[] | undefined;
  if ('dependsOn' in rec) {
    const v = rec.dependsOn;
    if (!Array.isArray(v)) return fail('dependsOn must be an array of positive integers, D<n> ids or T<n> ids');
    const nums = v.map(asDependency);
    if (!nums.every((d): d is number | `T${number}` => d !== undefined)) {
      return fail('every dependsOn entry must be a positive integer, a D<n> id or a T<n> id');
    }
    dependsOn = [...new Set(nums)];
    if (dependsOn.length > MAX_PROPOSAL_DEPENDS_ON) {
      return fail(`dependsOn must have at most ${MAX_PROPOSAL_DEPENDS_ON} entries`);
    }
  }

  let constraints: string[] | undefined;
  if ('constraints' in rec) {
    const v = rec.constraints;
    if (!Array.isArray(v) || !v.every((c): c is string => typeof c === 'string')) {
      return fail('constraints must be an array of strings');
    }
    const trimmed = v.map((c) => c.replace(ALL_CONTROLS, '').trim());
    if (trimmed.some((c) => c === '')) return fail('constraints entries must not be empty');
    if (trimmed.some((c) => c.length > MAX_CONSTRAINT_LEN)) {
      return fail(`each constraints entry must be at most ${MAX_CONSTRAINT_LEN} characters`);
    }
    constraints = [...new Set(trimmed)];
    if (constraints.length > MAX_PROPOSAL_CONSTRAINTS) {
      return fail(`constraints must have at most ${MAX_PROPOSAL_CONSTRAINTS} entries`);
    }
  }

  const priority = 'priority' in rec ? asPriorityLevel(rec.priority) : undefined;
  if ('priority' in rec && priority === undefined) {
    return fail(`priority must be one of ${PRIORITY_LEVELS.join(', ')}`);
  }
  let priorityReason: string | undefined;
  if ('priorityReason' in rec) {
    if (priority === undefined) return fail('priorityReason needs a priority');
    const r = rec.priorityReason;
    if (typeof r !== 'string' || /[\r\n]/.test(r)) return fail('priorityReason must be a single-line string');
    priorityReason = r.replace(ALL_CONTROLS, '').trim();
    if (priorityReason === '' || priorityReason.length > MAX_PRIORITY_REASON) {
      return fail(`priorityReason must be 1-${MAX_PRIORITY_REASON} characters`);
    }
  }

  let attachments: ProposalAttachment[] | undefined;
  if ('attachments' in rec) {
    const a = validateAttachments(rec.attachments);
    if (!a.ok) return fail(a.reason);
    attachments = a.value;
  }

  if (id !== undefined && dependsOn?.includes(id)) {
    return fail('dependsOn may not contain the proposal\'s own id');
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
  if (dependsOn !== undefined) value.dependsOn = dependsOn;
  if (constraints !== undefined) value.constraints = constraints;
  if (priority !== undefined) value.priority = priority;
  if (priorityReason !== undefined) value.priorityReason = priorityReason;
  if (attachments !== undefined) value.attachments = attachments;
  return { ok: true, value };
}
