import type { ContextBrief, BriefPerson, BriefRelation } from './ticketing.js';
import { renderAttachmentSection, escapeInline, safeUrl } from './attachmentMarkdown.js';
import { PLANNING_BRIEF_HEADING } from '../model/planningBriefHeading.js';

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

// ---- the inverse: the stored brief back into its sections (display only; nothing is written back) ----

export interface BriefRow {
  readonly label: string;
  readonly value: string;
}

export interface ParsedBriefAttachment {
  readonly name: string;
  readonly size?: string;
  readonly url?: string;
}

export interface ParsedBrief {
  /** The description and every part no known heading claims; the leading `# <title>` line is dropped. */
  readonly body: string;
  /** Everything under the planning-brief heading (its design constraints included), or null. */
  readonly planning: string | null;
  readonly details: readonly BriefRow[];
  readonly people: readonly BriefRow[];
  readonly relations: readonly BriefRow[];
  readonly dates: readonly BriefRow[];
  readonly links: readonly string[];
  readonly tags: readonly string[];
  readonly comments: readonly { readonly author: string; readonly text: string }[];
  readonly attachments: readonly ParsedBriefAttachment[];
}

type SectionKey = 'details' | 'people' | 'relations' | 'dates' | 'links' | 'comments' | 'attachments';

const SECTION_HEADINGS: Readonly<Record<string, SectionKey>> = {
  '## Details': 'details',
  '## People': 'people',
  '## Relations': 'relations',
  '## Dates': 'dates',
  '## Links': 'links',
  '## Comments': 'comments',
  '## Attachments': 'attachments',
};

const unescapeInline = (text: string): string => text.replace(/\\([\\`*_[\]()<>#|~])/g, '$1');
const SIZE_RE = /\d+(?:\.\d+)? (?:KB|MB|B)(?=[ _·]|$)/;
const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)\)/;

function toRow(line: string): BriefRow | null {
  const m = /^- ([^:]+): (.*)$/.exec(line);
  return m ? { label: m[1]!.trim(), value: unescapeInline(m[2]!.trim()) } : null;
}

function rowsOf(lines: readonly string[]): BriefRow[] {
  return lines.map(toRow).filter((r): r is BriefRow => r !== null);
}

function commentsOf(lines: readonly string[]): { author: string; text: string }[] {
  const out: { author: string; text: string }[] = [];
  for (const line of lines) {
    const m = /^- ([^:]*): ?(.*)$/.exec(line);
    if (m) out.push({ author: m[1]!, text: m[2]! });
    else if (out.length) out[out.length - 1]!.text += `\n${line}`;
  }
  return out.map((c) => ({ author: c.author, text: c.text.replace(/\s+$/, '') }));
}

function attachmentsOf(lines: readonly string[]): ParsedBriefAttachment[] {
  const out: ParsedBriefAttachment[] = [];
  let current: { name: string; size?: string; url?: string } | null = null;
  let fence = '';
  for (const line of lines) {
    if (fence) {
      if (line.trim() === fence) fence = '';
      continue;
    }
    const heading = /^### (.*)$/.exec(line);
    if (heading) {
      current = { name: unescapeInline(heading[1]!.trim()) };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const open = /^(`{3,})/.exec(line);
    if (open) fence = open[1]!;
    else if (line.startsWith('_') && SIZE_RE.test(line)) current.size = SIZE_RE.exec(line)![0];
    else if (!current.url) current.url = LINK_RE.exec(line)?.[1];
  }
  return out.map((a) => ({ name: a.name, ...(a.size ? { size: a.size } : {}), ...(a.url ? { url: a.url } : {}) }));
}

/** Splits the planning section off the brief: on top (the whole brief) or after a fetched brief. */
function splitPlanning(markdown: string): { head: string; planning: string | null } {
  const top = `${PLANNING_BRIEF_HEADING}\n`;
  if (markdown.startsWith(top)) return { head: '', planning: markdown.slice(top.length).trim() };
  const at = markdown.lastIndexOf(`\n${top}`);
  if (at < 0) return { head: markdown, planning: null };
  return { head: markdown.slice(0, at), planning: markdown.slice(at + top.length + 1).trim() };
}

/** The inverse of `renderBrief`: reads the headings it emits and leaves everything else in `body`. */
export function parseBriefSections(markdown: string): ParsedBrief {
  const { head, planning } = splitPlanning(markdown);
  const lines = head.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first >= 0 && /^# /.test(lines[first]!)) lines.splice(first, 1);
  const body: string[] = [];
  const sections: Record<SectionKey, string[]> = { details: [], people: [], relations: [], dates: [], links: [], comments: [], attachments: [] };
  let tags: string[] = [];
  let current: SectionKey | null = null;
  let afterBlank = false;
  for (const line of lines) {
    const known = SECTION_HEADINGS[line.trim()];
    if (known) {
      current = known;
    } else if (afterBlank && current !== 'comments' && current !== 'attachments' && line.startsWith('Tags: ')) {
      tags = line.slice('Tags: '.length).split(',').map((t) => t.trim()).filter(Boolean);
      current = null;
    } else if (/^## /.test(line) && current !== 'comments' && current !== 'attachments') {
      current = null;
      body.push(line);
    } else if (current) {
      sections[current].push(line);
    } else {
      body.push(line);
    }
    afterBlank = line.trim() === '';
  }
  const bullets = (key: SectionKey): string[] => sections[key].filter((l) => l.startsWith('- '));
  return {
    body: body.join('\n').trim(),
    planning,
    details: rowsOf(bullets('details')),
    people: rowsOf(bullets('people')),
    relations: rowsOf(bullets('relations')),
    dates: rowsOf(bullets('dates')),
    links: bullets('links').map((l) => l.slice(2).trim()),
    tags,
    comments: commentsOf(sections.comments.filter((l) => l.trim() !== '' || sections.comments.length > 0)),
    attachments: attachmentsOf(sections.attachments),
  };
}
