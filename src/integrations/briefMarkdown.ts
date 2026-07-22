import type { ContextBrief, BriefPerson, BriefRelation } from './ticketing.js';
import { renderAttachmentSection, escapeInline, safeUrl } from './attachmentMarkdown.js';

/**
 * The ONE place a fetched `ContextBrief` becomes the plain-markdown string that
 * is persisted on the ticket and later embedded verbatim into the agent's launch
 * context. Pure and vscode-free, so the exact rendering is unit-tested.
 *
 * Backward-compat invariant: the enrichment sections (Details, People,
 * Relations, Dates, Links) each emit NOTHING when their field is absent, and are
 * inserted AFTER the description and BEFORE the pre-existing Tags/Comments/
 * Attachments blocks. A brief carrying only the original five fields therefore
 * renders byte-identically to the pre-enrichment brief.
 *
 * Every enrichment field is untrusted provider data, so labels/refs are escaped
 * inline (see `attachmentMarkdown`) and URLs pass through `safeUrl`, which drops
 * a non-http(s) scheme and strips any pre-signed query/fragment credential.
 */

const RELATION_LABEL: Record<BriefRelation['kind'], string> = {
  blocks: 'Blocks',
  'blocked-by': 'Blocked by',
  parent: 'Parent',
  child: 'Child',
  duplicate: 'Duplicate of',
  related: 'Related to',
};

const ROLE_LABEL: Record<BriefPerson['role'], string> = {
  assignee: 'Assignee',
  reporter: 'Reporter',
  watcher: 'Watcher',
};

/** Wrap a set of body rows under a heading, or nothing when there are no rows. */
function section(heading: string, rows: string[]): string[] {
  return rows.length ? ['', heading, ...rows] : [];
}

/** Status, priority, milestone, and the canonical link — the ticket's header facts. */
function detailRows(brief: ContextBrief): string[] {
  const rows: string[] = [];
  if (brief.status) rows.push(`- Status: ${escapeInline(brief.status)}`);
  if (brief.priority) rows.push(`- Priority: ${escapeInline(brief.priority)}`);
  if (brief.milestone) rows.push(`- Sprint/Milestone: ${escapeInline(brief.milestone)}`);
  if (brief.url) {
    const href = safeUrl(brief.url);
    if (href) rows.push(`- Link: ${href}`);
  }
  return section('## Details', rows);
}

function peopleRows(brief: ContextBrief): string[] {
  const rows = (brief.people ?? []).map((p) => {
    const email = p.email ? ` <${escapeInline(p.email)}>` : '';
    return `- ${ROLE_LABEL[p.role]}: ${escapeInline(p.name)}${email}`;
  });
  return section('## People', rows);
}

function relationRows(brief: ContextBrief): string[] {
  const rows = (brief.relations ?? []).map((r) => {
    const title = r.title ? ` — ${escapeInline(r.title)}` : '';
    const status = r.status ? ` (${escapeInline(r.status)})` : '';
    return `- ${RELATION_LABEL[r.kind]}: ${escapeInline(r.ref)}${title}${status}`;
  });
  return section('## Relations', rows);
}

function dateRows(brief: ContextBrief): string[] {
  const t = brief.timestamps;
  if (!t) return [];
  const rows: string[] = [];
  if (t.created) rows.push(`- Created: ${escapeInline(t.created)}`);
  if (t.updated) rows.push(`- Updated: ${escapeInline(t.updated)}`);
  if (t.start) rows.push(`- Start: ${escapeInline(t.start)}`);
  if (t.due) rows.push(`- Due: ${escapeInline(t.due)}`);
  if (t.closed) rows.push(`- Closed: ${escapeInline(t.closed)}`);
  return section('## Dates', rows);
}

function linkRows(brief: ContextBrief): string[] {
  const rows: string[] = [];
  for (const l of brief.links ?? []) {
    const href = safeUrl(l);
    if (href) rows.push(`- ${href}`);
  }
  return section('## Links', rows);
}

/** Render a fetched brief into the plain-text `brief` column. */
export function renderBrief(brief: ContextBrief): string {
  // Title/description/Tags/Comments are emitted verbatim (unescaped) exactly as
  // the pre-enrichment renderer did, so existing briefs are unchanged.
  const lines = [`# ${brief.title}`, '', brief.description];
  lines.push(...detailRows(brief));
  lines.push(...peopleRows(brief));
  lines.push(...relationRows(brief));
  lines.push(...dateRows(brief));
  lines.push(...linkRows(brief));
  if (brief.tags.length) lines.push('', `Tags: ${brief.tags.join(', ')}`);
  if (brief.comments.length) {
    lines.push('', '## Comments');
    for (const c of brief.comments) lines.push(`- ${c.author}: ${c.text}`);
  }
  // Attachments come last and only when present, so a ticket without them
  // renders exactly the string it did before attachments were embedded.
  lines.push(...renderAttachmentSection(brief.attachments));
  return lines.join('\n');
}
